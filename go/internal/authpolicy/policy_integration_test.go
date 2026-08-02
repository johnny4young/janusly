//go:build integration

package authpolicy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/go/internal/auth"
	"github.com/johnny4young/janusly/go/internal/store"
)

func policyTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(t.Context(), dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestSsoPersistenceIsTenantScopedAndNonceIsSingleUse(t *testing.T) {
	pool := policyTestPool(t)
	ctx := context.Background()
	q := store.New(pool)
	suffix := fmt.Sprint(time.Now().UnixNano())
	orgID := "org-sso-store-" + suffix
	connectionID := "sso-" + suffix

	created, err := q.CreateSsoConnection(ctx, store.CreateSsoConnectionParams{
		ID: connectionID, OrgID: orgID, Provider: "workos",
		ProviderConnectionID: "conn_original", EnforcedSso: false,
	})
	if err != nil || created.Status != "active" || created.Provider != "workos" {
		t.Fatalf("create: row=%+v err=%v", created, err)
	}
	found, err := q.FindSsoConnectionForOrg(ctx, orgID)
	if err != nil || found.ID != connectionID {
		t.Fatalf("find by org: row=%+v err=%v", found, err)
	}
	if _, err := q.GetSsoConnectionByID(ctx, store.GetSsoConnectionByIDParams{
		ID: connectionID, OrgID: "foreign-org",
	}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("cross-org connection read must fail closed: %v", err)
	}
	updated, err := q.UpdateSsoConnection(ctx, store.UpdateSsoConnectionParams{
		ID: connectionID, OrgID: orgID,
		EnforcedSso:          pgtype.Bool{Bool: true, Valid: true},
		ProviderConnectionID: pgtype.Text{String: "conn_rotated", Valid: true},
	})
	if err != nil || !updated.EnforcedSso || updated.ProviderConnectionID != "conn_rotated" || updated.Status != "active" {
		t.Fatalf("partial update: row=%+v err=%v", updated, err)
	}
	revoked, err := q.RevokeSsoConnection(ctx, store.RevokeSsoConnectionParams{ID: connectionID, OrgID: orgID})
	if err != nil || revoked.Status != "revoked" {
		t.Fatalf("revoke: row=%+v err=%v", revoked, err)
	}

	nonce := "nonce-" + suffix
	if err := q.RecordSsoNonce(ctx, store.RecordSsoNonceParams{
		ID: "nonce-row-" + suffix, OrgID: orgID, Nonce: nonce,
		ExpiresAt: time.Now().Add(time.Minute),
	}); err != nil {
		t.Fatalf("record nonce: %v", err)
	}
	const consumers = 8
	results := make(chan error, consumers)
	var wg sync.WaitGroup
	for range consumers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := q.ConsumeSsoNonce(ctx, store.ConsumeSsoNonceParams{OrgID: orgID, Nonce: nonce})
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	winners, losers := 0, 0
	for err := range results {
		if err == nil {
			winners++
		} else if errors.Is(err, pgx.ErrNoRows) {
			losers++
		} else {
			t.Fatalf("consume: %v", err)
		}
	}
	if winners != 1 || losers != consumers-1 {
		t.Fatalf("nonce claim: winners=%d losers=%d", winners, losers)
	}
	if err := q.RecordSsoNonce(ctx, store.RecordSsoNonceParams{
		ID: "expired-row-" + suffix, OrgID: orgID, Nonce: "expired-" + suffix,
		ExpiresAt: time.Now().Add(-time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.ConsumeSsoNonce(ctx, store.ConsumeSsoNonceParams{
		OrgID: orgID, Nonce: "expired-" + suffix,
	}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("expired nonce must never authorize: %v", err)
	}
}

func TestEvaluatorLoadsNarrowConfigAndAuditsRejections(t *testing.T) {
	pool := policyTestPool(t)
	ctx := context.Background()
	q := store.New(pool)
	suffix := fmt.Sprint(time.Now().UnixNano())
	orgID := "org-auth-policy-" + suffix
	if _, err := q.CreateSsoConnection(ctx, store.CreateSsoConnectionParams{
		ID: "sso-policy-" + suffix, OrgID: orgID, Provider: "workos",
		ProviderConnectionID: "conn_policy", EnforcedSso: true,
	}); err != nil {
		t.Fatalf("connection: %v", err)
	}
	values := []struct {
		key, value, valueType string
	}{
		{PolicyAllowedDomain, `"acme.com, Partner.Example"`, "string"},
		{PolicyMFARequired, `true`, "boolean"},
		{"auth.sessionTtlSeconds", `900`, "number"},
	}
	for i, item := range values {
		if err := q.UpsertOrgConfigValue(ctx, store.UpsertOrgConfigValueParams{
			ID: fmt.Sprintf("policy-%s-%d", suffix, i), OrgID: orgID, Key: item.key,
			ValueJson: json.RawMessage(item.value), Category: "auth", Description: "test",
			ValueType: item.valueType, UpdatedBy: pgtype.Text{String: "tester", Valid: true},
		}); err != nil {
			t.Fatalf("config %s: %v", item.key, err)
		}
	}

	evaluator := New(pool)
	rejected := evaluator.Evaluate(ctx, Input{
		OrgID: orgID, UserID: "supabase-user", Email: "ada@acme.com", Mode: auth.ModeSupabase,
	})
	if rejected.Allowed || rejected.PolicyKey != PolicyEnforcedSSO || rejected.SessionTTLSeconds != 900 {
		t.Fatalf("enforced decision: %+v", rejected)
	}
	t.Setenv("ALLOW_DEV_SSO_BYPASS", "true")
	allowed := evaluator.Evaluate(ctx, Input{
		OrgID: orgID, UserID: "supabase-user", Email: "ada@partner.example", Mode: auth.ModeSupabase,
	})
	if !allowed.Allowed || allowed.SessionTTLSeconds != 900 {
		t.Fatalf("bypass + normalized domain: %+v", allowed)
	}
	badSession := evaluator.Evaluate(ctx, Input{
		OrgID: orgID, UserID: "sso-user", Email: "ada@outside.example", Mode: auth.ModeJanuslySession,
	})
	if badSession.Allowed || badSession.PolicyKey != PolicyAllowedDomain {
		t.Fatalf("session domain decision: %+v", badSession)
	}
	service := evaluator.Evaluate(ctx, Input{
		OrgID: orgID, UserID: "service", Mode: auth.ModeServiceToken,
	})
	if !service.Allowed {
		t.Fatalf("service bypass: %+v", service)
	}
	var audits int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM audit_logs WHERE org_id = $1 AND action = 'auth.policy.rejected'`, orgID,
	).Scan(&audits); err != nil || audits != 2 {
		t.Fatalf("rejection audits: count=%d err=%v", audits, err)
	}
}
