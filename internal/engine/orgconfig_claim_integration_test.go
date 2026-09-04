//go:build integration

package engine

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/domain"
)

// A node used to pay one pool round trip per config key it consulted
// (http bounds, agent consent, resume TTL, subworkflow depth). The claim
// now reads the tenant rows once, on first need, and resolves every key
// from them; a hand-built claim without a snapshot still reads per call.
func TestClaimResolvesOrgConfigFromOneTenantRead(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set; run through `make test`")
	}
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	counter := &queryCounter{}
	cfg.ConnConfig.Tracer = counter
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	raw := make([]byte, 6)
	_, _ = rand.Read(raw)
	org := "org-claimcfg-" + hex.EncodeToString(raw)
	for key, value := range map[string]string{"runs.humanFormResumeTtlSeconds": "900", "http.timeoutMs": "1234"} {
		if _, err := pool.Exec(ctx, `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
			VALUES ($1, $2, $3, $4::jsonb, 'test', 'test', 'number')`, org+"-"+key, org, key, value); err != nil {
			t.Fatalf("seed %s: %v", key, err)
		}
	}
	eng := New(pool)
	noEnv := func(string) (string, bool) { return "", false }

	claim := ClaimedNode{RunID: "run", NodeID: "node", OrgID: org}.withSnapshot(&domain.Workflow{}, nil, "", "version")
	counter.reset()
	if ttl := eng.claimConfigNumber(ctx, claim, "runs.humanFormResumeTtlSeconds"); ttl != 900 {
		t.Fatalf("tenant TTL must win: got %v", ttl)
	}
	if bounds := eng.claimHTTPBounds(ctx, claim, noEnv); bounds.TimeoutMs != 1234 {
		t.Fatalf("tenant http bound must win: got %+v", bounds)
	}
	_ = eng.claimConfigNumber(ctx, claim, "subworkflow.maxDepth")
	_ = eng.claimConfigBool(ctx, claim, "ai.agentWriteConsent")
	if got := counter.get("ListOrgConfigRows"); got != 1 {
		t.Fatalf("four lookups on one claim must read the tenant rows once, got %d", got)
	}

	bare := ClaimedNode{RunID: "run", NodeID: "node", OrgID: org}
	counter.reset()
	_ = eng.claimConfigNumber(ctx, bare, "runs.humanFormResumeTtlSeconds")
	_ = eng.claimHTTPBounds(ctx, bare, noEnv)
	if got := counter.get("ListOrgConfigRows"); got != 2 {
		t.Fatalf("a claim without a snapshot has nowhere to hold rows; want 2 reads, got %d", got)
	}
}
