package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestContractWebCallsUsesConcreteTransport(t *testing.T) {
	cases := []struct{ name, source, want string }{
		{"v1 read", "contractApi('GET /authoring/experiences', `/v1/authoring/experiences?workflowId=${encodeURIComponent(id)}`, undefined)", "/v1/authoring/experiences"},
		{"v1 register", "contractApi('POST /authoring/experiences/register', '/v1/authoring/experiences/register', body)", "/v1/authoring/experiences/register"},
		{"v1 revoke multiline", "contractApi(\n  \"POST /authoring/experiences/revoke\",\n  \"/v1/authoring/experiences/revoke\", body)", "/v1/authoring/experiences/revoke"},
		{"legacy rewritten read", "contractApi('GET /status', `/status?runId=${id}`, undefined)", "/v1/status"},
		{"dynamic path fallback", "contractApi('GET /status', path, undefined)", "/v1/status"},
		{"dynamic template fallback", "contractApi('GET /status', `${path}?runId=${id}`, undefined)", "/v1/status"},
		{"dynamic prefix fallback", "contractApi('POST /workflows/{workflowId}/rollout/{rolloutId}/{decision}', `${rolloutPath}/${encodeURIComponent(rolloutId)}/${decision}`, body)", "/workflows/x/rollout/x/x"},
		{"dynamic segment", "contractApi('GET /dlq/entries/{deadLetterId}', `/v1/dlq/entries/${encodeURIComponent(id)}`, undefined)", "/v1/dlq/entries/x"},
		{"quoted template expression", "contractApi('GET /dlq/entries/{deadLetterId}', `/v1/dlq/entries/${encodeURIComponent(id || 'fallback')}`, undefined)", "/v1/dlq/entries/x"},
		{"wrong transport stays visible", "contractApi('POST /authoring/experiences/revoke', '/v1/workflows/save', body)", "/v1/workflows/save"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls := contractWebCalls(tc.source, "fixture.tsx")
			if len(calls) != 1 {
				t.Fatalf("calls=%+v", calls)
			}
			if got := wirePath(calls[0], map[string]bool{"/status": true}); got != tc.want {
				t.Fatalf("wire=%q want=%q", got, tc.want)
			}
			if calls[0].file != "fixture.tsx" || calls[0].line != 1 || !calls[0].contracted {
				t.Fatalf("metadata=%+v", calls[0])
			}
		})
	}
}

func TestContractWebCallsV1OnlyRoutesHaveNoLegacyAlias(t *testing.T) {
	mux := http.NewServeMux()
	(&V1Server{}).mountAPIRoutes(mux)
	for _, source := range []string{
		"contractApi('GET /authoring/experiences', '/v1/authoring/experiences', undefined)",
		"contractApi('POST /authoring/experiences/register', '/v1/authoring/experiences/register', body)",
		"contractApi('POST /authoring/experiences/revoke', '/v1/authoring/experiences/revoke', body)",
	} {
		call := contractWebCalls(source, "fixture.tsx")[0]
		_, pattern := mux.Handler(httptest.NewRequest(call.method, wirePath(call, map[string]bool{}), nil))
		if pattern == "" {
			t.Errorf("explicit v1 path unresolved: %s", source)
		}
		_, legacy := mux.Handler(httptest.NewRequest(call.method, call.path, nil))
		if legacy != "" {
			t.Errorf("unexpected legacy alias: %s", legacy)
		}
	}
}

func TestContractWebCallsChecksOperationAgainstTransport(t *testing.T) {
	cases := []struct {
		name, operation, concrete string
		want                      bool
	}{
		{"explicit v1", "POST /authoring/experiences/revoke", "/v1/authoring/experiences/revoke", true},
		{"legacy", "POST /workflows/save", "/workflows/save", true},
		{"query", "GET /status", "/v1/status?runId=${id}", true},
		{"dynamic segment", "GET /dlq/entries/{deadLetterId}", "/v1/dlq/entries/${id}", true},
		{"wrong registered operation", "POST /authoring/experiences/revoke", "/v1/workflows/save", false},
		{"wrong prefix", "GET /status", "/v2/status", false},
		{"extra segment", "GET /status", "/v1/status/extra", false},
		{"missing param", "GET /dlq/entries/{deadLetterId}", "/v1/dlq/entries/", false},
		{"hash", "GET /status", "/v1/status#anchor", false},
		{"empty", "GET /status", "", false},
		{"absolute", "GET /status", "https://example.test/v1/status", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls := contractWebCalls("contractApi('"+tc.operation+"', `"+tc.concrete+"`, undefined)", "fixture.tsx")
			if len(calls) != 1 || !calls[0].hasConcretePath {
				t.Fatalf("calls=%+v", calls)
			}
			if got := contractPathMatchesOperation(calls[0]); got != tc.want {
				t.Errorf("matches=%v want=%v", got, tc.want)
			}
		})
	}
}

func TestContractWebCallsPreservesEveryTransportAndLocation(t *testing.T) {
	source := "contractApi('POST /workflows/save', '/v1/workflows/save', body)\ncontractApi('POST /workflows/save', '/bad/workflows/save', body)"
	calls := contractWebCalls(source, "fixture.tsx")
	if len(calls) != 2 {
		t.Fatalf("calls=%+v", calls)
	}
	if calls[1].line != 2 || contractPathMatchesOperation(calls[1]) || !contractPathMatchesOperation(calls[0]) {
		t.Fatalf("calls=%+v", calls)
	}
	if wirePath(calls[0], nil) == wirePath(calls[1], nil) {
		t.Fatal("different transports collapsed")
	}
}
