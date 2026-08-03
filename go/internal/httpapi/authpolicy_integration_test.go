//go:build integration

package httpapi

import (
	"context"
	"testing"

	"github.com/johnny4young/janusly/go/internal/store"
)

func TestHTTPResolverEnforcesCentralSsoPolicy(t *testing.T) {
	h := newAPIHarness(t)
	pool := testPool(t)
	ctx := context.Background()
	if _, err := store.New(pool).CreateSsoConnection(ctx, store.CreateSsoConnectionParams{
		ID: h.org + "-sso", OrgID: h.org, Provider: "workos",
		ProviderConnectionID: "conn_http_policy", EnforcedSso: true,
	}); err != nil {
		t.Fatalf("seed SSO connection: %v", err)
	}

	rejected := h.call("GET", "/tools", nil, "")
	errorBody, _ := rejected.body["error"].(map[string]any)
	if rejected.status != 401 || errorBody["code"] != "server_request_failed" {
		t.Fatalf("enforced SSO must reject dev headers: %d %+v", rejected.status, rejected.body)
	}
	var audits int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND user_id = 'api-tester' AND action = 'auth.policy.rejected'`, h.org).Scan(&audits); err != nil || audits != 1 {
		t.Fatalf("policy rejection audit: count=%d err=%v", audits, err)
	}

	t.Setenv("ALLOW_DEV_SSO_BYPASS", "true")
	allowed := h.call("GET", "/tools", nil, "")
	if allowed.status != 200 {
		t.Fatalf("explicit incident bypass: %d %+v", allowed.status, allowed.body)
	}
}
