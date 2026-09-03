package workos

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/executors"
)

func TestBuildAuthorizeURLBindsConnectionRedirectAndState(t *testing.T) {
	client := New(Config{ClientID: "client_test"})
	raw, err := client.BuildAuthorizeURL("conn_acme", "https://api.example.com/auth/sso/callback", "signed.state")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Scheme != "https" || parsed.Host != "api.workos.com" || parsed.Path != "/sso/authorize" {
		t.Fatalf("authorize endpoint = %s", parsed)
	}
	want := map[string]string{
		"client_id": "client_test", "connection": "conn_acme",
		"redirect_uri":  "https://api.example.com/auth/sso/callback",
		"response_type": "code", "state": "signed.state",
	}
	for key, value := range want {
		if parsed.Query().Get(key) != value {
			t.Fatalf("%s = %q", key, parsed.Query().Get(key))
		}
	}
	if _, err := New(Config{}).BuildAuthorizeURL("conn", "https://callback", "state"); !errors.Is(err, ErrClientIDNotConfigured) {
		t.Fatalf("missing client id = %v", err)
	}
}

func TestExchangeCodeUsesGuardedBoundedRequestAndParsesProfile(t *testing.T) {
	var target string
	var options executors.FetchOptions
	client := New(Config{
		ClientID: "client_test", APIKey: "sk_test_secret",
		Fetch: func(_ context.Context, rawURL string, opts executors.FetchOptions) (executors.FetchResult, error) {
			target, options = rawURL, opts
			return executors.FetchResult{StatusCode: 200, Ok: true, Body: `{
				"profile":{"id":"user_01","email":"ADA@ACME.COM","first_name":"Ada",
				"last_name":null,"connection_id":"conn_acme","organization_id":"org_workos"}}
			`}, nil
		},
	})
	profile, err := client.ExchangeCode(t.Context(), "code_01", "https://api.example.com/auth/sso/callback")
	if err != nil {
		t.Fatal(err)
	}
	if target != defaultTokenURL || options.Method != http.MethodPost || !options.DisableRedirects ||
		options.TimeoutMs != exchangeTimeoutMs || options.MaxResponseBytes != exchangeBodyCap {
		t.Fatalf("guarded request = target:%s options:%+v", target, options)
	}
	form, err := url.ParseQuery(string(options.Body))
	if err != nil {
		t.Fatal(err)
	}
	if form.Get("client_secret") != "sk_test_secret" || form.Get("code") != "code_01" ||
		options.Headers["WorkOS-Version"] != apiVersion {
		t.Fatalf("exchange request = form:%v headers:%v", form, options.Headers)
	}
	if profile.ID != "user_01" || profile.Email != "ada@acme.com" ||
		profile.ConnectionID != "conn_acme" || profile.FirstName == nil || *profile.FirstName != "Ada" ||
		profile.LastName != nil || profile.OrganizationID == nil || *profile.OrganizationID != "org_workos" {
		t.Fatalf("profile = %+v", profile)
	}
	leakSafe := New(Config{ClientID: "client_test", APIKey: "sk_test_secret", Fetch: func(context.Context, string, executors.FetchOptions) (executors.FetchResult, error) {
		return executors.FetchResult{}, errors.New("network unavailable")
	}})
	_, err = leakSafe.ExchangeCode(t.Context(), "code", "https://callback")
	if err == nil || strings.Contains(err.Error(), "sk_test_secret") {
		t.Fatal("errors must never expose the API key")
	}
}

func TestExchangeCodeClassifiesUpstreamAndShapeFailures(t *testing.T) {
	tests := []struct {
		name   string
		result executors.FetchResult
		status int
	}{
		{"upstream status", executors.FetchResult{StatusCode: 401, Body: `{"error":"invalid_client"}`}, 401},
		{"non JSON", executors.FetchResult{StatusCode: 200, Ok: true, Body: `<html>`}, 200},
		{"missing binding", executors.FetchResult{StatusCode: 200, Ok: true, Body: `{"profile":{"id":"user"}}`}, 200},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := New(Config{ClientID: "client", APIKey: "secret", Fetch: func(context.Context, string, executors.FetchOptions) (executors.FetchResult, error) {
				return tt.result, nil
			}})
			_, err := client.ExchangeCode(t.Context(), "code", "https://callback")
			var exchangeErr *ExchangeError
			if !errors.As(err, &exchangeErr) || exchangeErr.StatusCode != tt.status {
				t.Fatalf("error = %T %v", err, err)
			}
		})
	}
}
