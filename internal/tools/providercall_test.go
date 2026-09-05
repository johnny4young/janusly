package tools

import (
	"context"
	"strings"
	"testing"
	"time"
)

type recordedCall struct {
	tool, credential, message string
	ok                        bool
	statusCode                int
}

func fakeProviderDeps(t *testing.T, gateError string, status int, body, transportError string) (*IntegrationDeps, *[]recordedCall, *int) {
	t.Helper()
	records := &[]recordedCall{}
	gatedLimit := new(int)
	return &IntegrationDeps{
		Gate: func(_ context.Context, _, kind, name string, perMin int) (string, string) {
			if kind != "test_token" || name != "cred" {
				t.Fatalf("gate saw kind=%q name=%q", kind, name)
			}
			*gatedLimit = perMin
			return "secret", gateError
		},
		Fetch: func(_ context.Context, method, target string, headers map[string]string, _ []byte, _ int) (int, string, string) {
			if method != "GET" || target != "https://provider.test/x" || headers["authorization"] != "Token secret" {
				t.Fatalf("request shape leaked: %s %s %v", method, target, headers)
			}
			return status, body, transportError
		},
		Record: func(tool, credential string, ok bool, statusCode int, message string, _ int) {
			*records = append(*records, recordedCall{tool, credential, message, ok, statusCode})
		},
		RateLimitPerMin: func(_ string, fallback int) int { return fallback },
	}, records, gatedLimit
}

func testProviderCall(override any, hasOverride bool) providerCall {
	return providerCall{
		tool: "test.op", credentialKind: "test_token", credential: "cred",
		rateLimitFamily: "test", rateLimitDefault: 50,
		rateLimitOverride: override, hasRateLimitOverride: hasOverride,
		responseMaxBytes: 1024,
		request: func(secret string) (string, string, map[string]string, []byte, string) {
			return "GET", "https://provider.test/x", map[string]string{"authorization": "Token " + secret}, nil, ""
		},
		receipt: func(_ int, body string, _ time.Time) (map[string]any, string) {
			if !strings.Contains(body, "done") {
				return nil, "receipt did not prove the operation"
			}
			return map[string]any{"detail": body}, ""
		},
		failure: func(statusCode int, transportError string) string {
			if statusCode > 0 {
				return "provider failed"
			}
			return "provider unreachable: " + transportError
		},
	}
}

func TestProviderCallSuccessMergesReceiptAndRecords(t *testing.T) {
	deps, records, limit := fakeProviderDeps(t, "", 200, `{"done":true}`, "")
	result := testProviderCall(nil, false).execute(context.Background(), deps)
	if result["ok"] != true || result["statusCode"] != 200 || result["detail"] != `{"done":true}` {
		t.Fatalf("unexpected result: %+v", result)
	}
	if _, ok := result["latencyMs"].(int); !ok {
		t.Fatalf("latencyMs missing: %+v", result)
	}
	if len(*records) != 1 || !(*records)[0].ok || (*records)[0].statusCode != 200 {
		t.Fatalf("success must record once: %+v", *records)
	}
	if *limit != 50 {
		t.Fatalf("tenant default must reach the gate, got %d", *limit)
	}
}

func TestProviderCallFailuresCarryStatusOnlyWhenKnown(t *testing.T) {
	cases := []struct {
		name          string
		gateError     string
		status        int
		body          string
		transport     string
		wantMessage   string
		wantStatusKey bool
	}{
		{"gate", "credential not found", 0, "", "", "credential not found", false},
		{"transport", "", 0, "", "dial refused", "provider unreachable: dial refused", false},
		{"non-2xx", "", 503, "busy", "", "provider failed", true},
		{"receipt", "", 200, `{"pending":true}`, "", "receipt did not prove the operation", true},
	}
	for _, tc := range cases {
		deps, records, _ := fakeProviderDeps(t, tc.gateError, tc.status, tc.body, tc.transport)
		result := testProviderCall(nil, false).execute(context.Background(), deps)
		if result["ok"] != false || result["error"] != tc.wantMessage {
			t.Fatalf("%s: unexpected result %+v", tc.name, result)
		}
		if _, present := result["statusCode"]; present != tc.wantStatusKey {
			t.Fatalf("%s: statusCode presence=%v want %v (%+v)", tc.name, present, tc.wantStatusKey, result)
		}
		if len(*records) != 1 || (*records)[0].ok || (*records)[0].message != tc.wantMessage {
			t.Fatalf("%s: failure must record once with the message: %+v", tc.name, *records)
		}
	}
}

func TestProviderCallOverrideOnlyLowersTheTenantCeiling(t *testing.T) {
	deps, _, limit := fakeProviderDeps(t, "", 200, "done", "")
	testProviderCall(float64(10), true).execute(context.Background(), deps)
	if *limit != 10 {
		t.Fatalf("a lower override must win, got %d", *limit)
	}
	testProviderCall(float64(900), true).execute(context.Background(), deps)
	if *limit != 50 {
		t.Fatalf("a higher override must not raise the ceiling, got %d", *limit)
	}
	deps, records, _ := fakeProviderDeps(t, "", 200, "done", "")
	result := testProviderCall("many", true).execute(context.Background(), deps)
	if result["ok"] != false || !strings.Contains(result["error"].(string), "rateLimitPerMin") || len(*records) != 0 {
		t.Fatalf("an invalid override must fail before any gate or record: %+v %+v", result, *records)
	}
}

func TestProviderCallRequiresRunContext(t *testing.T) {
	if result := testProviderCall(nil, false).execute(context.Background(), &IntegrationDeps{}); result["error"] != "integration tools require run context" {
		t.Fatalf("missing deps must fail closed: %+v", result)
	}
}
