//go:build integration

package authpolicy

import (
	"fmt"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/audit"
	"github.com/johnny4young/janusly/internal/auth"
	"github.com/johnny4young/janusly/internal/grammar"
	"github.com/johnny4young/janusly/internal/store"
)

func TestRejectionAuditUsesInjectedPolicy(t *testing.T) {
	pool := policyTestPool(t)
	policy, err := grammar.NewPersister(2)
	if err != nil {
		t.Fatal(err)
	}
	evaluator := New(pool, audit.NewWriter(policy))
	t.Setenv("ALLOW_DEV_SSO_BYPASS", "false")
	t.Setenv("JANUSLY_PERSIST_MAX_BYTES", "900000")
	org := fmt.Sprintf("auth-policy-bound-%d", time.Now().UnixNano())
	decision := evaluator.Evaluate(t.Context(), Input{OrgID: org, UserID: "policy-user", Mode: auth.ModeSupabase, ProvidedConnection: true, Connection: &store.SsoConnection{Status: "active", EnforcedSso: true}})
	if decision.Allowed || decision.PolicyKey != PolicyEnforcedSSO {
		t.Fatalf("expected SSO rejection: %+v", decision)
	}
	var raw string
	if err := pool.QueryRow(t.Context(), `SELECT metadata::text FROM audit_logs WHERE org_id=$1 AND action='auth.policy.rejected'`, org).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if raw != "{}" {
		t.Fatalf("policy rejection bypassed writer: %s", raw)
	}
}
