//go:build integration

package store

import (
	"context"
	"encoding/json"
	"os"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// On a populated table the needs-you inbox reads one organization's live tool
// approvals through their own index instead of every running run's requests.
func TestNeedsYouToolApprovalsUseTheOrganizationIndex(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, seed := range []string{
		`INSERT INTO runs (id, org_id, status, input_json, workflow_version_id)
		 SELECT 'plan-run-' || g, 'plan-org-' || (g % 200), CASE WHEN g % 10 = 0 THEN 'running' ELSE 'succeeded' END, '{}', 'v'
		 FROM generate_series(1, 20000) g`,
		`INSERT INTO tool_approval_requests (id, org_id, run_id, node_id, tool, params_json, params_digest, requester_ids,
		   status, expires_at, consumed_at, decided_by, decided_at, created_at)
		 SELECT 'plan-tar-' || g, 'plan-org-' || (g % 200), 'plan-run-' || g, 'n', 'tool', '{}', 'd', ARRAY['u'],
		   CASE WHEN g % 20 = 0 THEN 'pending' ELSE 'approved' END, now() + interval '1 day',
		   CASE WHEN g % 20 = 0 THEN NULL ELSE now() END, CASE WHEN g % 20 = 0 THEN NULL ELSE 'v' END,
		   CASE WHEN g % 20 = 0 THEN NULL ELSE now() END, now() - make_interval(secs => g)
		 FROM generate_series(1, 20000) g`,
		`ANALYZE runs`, `ANALYZE tool_approval_requests`,
		`PREPARE inbox_plan AS ` + listPendingToolApprovalsForOrg,
	} {
		if _, err := tx.Exec(ctx, seed); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	var planJSON []byte
	if err := tx.QueryRow(ctx, `EXPLAIN (FORMAT JSON) EXECUTE inbox_plan('plan-org-7', 'viewer')`).Scan(&planJSON); err != nil {
		t.Fatalf("explain: %v", err)
	}
	var parsed []map[string]any
	if err := json.Unmarshal(planJSON, &parsed); err != nil {
		t.Fatal(err)
	}
	var indexes []string
	walkPlan(parsed[0]["Plan"].(map[string]any), func(node map[string]any) {
		if name, _ := node["Index Name"].(string); name != "" {
			indexes = append(indexes, name)
		}
	})
	if !slices.Contains(indexes, "tool_approval_requests_org_pending_idx") {
		t.Fatalf("inbox plan does not use the organization index: %v", indexes)
	}
}
