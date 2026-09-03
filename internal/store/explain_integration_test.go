//go:build integration

// The executable EXPLAIN sweep over the hot queries. With
// enable_seqscan forced off, a Seq Scan surviving in the plan over a
// WATCHED (grows-with-usage) table means no index CAN serve the
// predicate — a missing index, not a cost-based choice. Runs against the
// live schema regardless of row counts.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// watchedTables grow with usage; a plan that can only seq-scan them is a
// finding. Catalog-sized tables (orgs, org_configs, snippets…) are exempt.
var watchedTables = map[string]bool{
	"runs": true, "run_nodes": true, "run_events": true,
	"dead_letters": true, "recovery_items": true, "recovery_item_children": true,
	"workflow_versions": true, "workflows": true,
	"scim_user_state": true, "scim_user_groups": true, "scim_group_role_mappings": true,
	"eval_examples": true, "usage_events": true, "audit_logs": true,
	"trigger_events": true, "schedule_entries": true,
}

type explainCase struct {
	name string
	sql  string
	args []any
}

func TestHotQueryPlansAreIndexServed(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()

	now := "2026-08-01T00:00:00Z"
	cases := []explainCase{
		// The count semantics: runs joined through version rows.
		{"listWorkflowRows", listWorkflowRows, []any{"org-x", now, "id-x", "[]", nil, nil, int32(50)}},
		{"listDeletedWorkflowRows", listDeletedWorkflowRows, []any{"org-x", now, "id-x", int32(50)}},
		{"listRunSummaries", listRunSummaries, []any{"org-x", now, "id-x", nil, nil, int32(50)}},
		{"listDeadLetterSummaries", listDeadLetterSummaries, []any{"org-x", nil, nil, nil, int32(50)}},
		{"listRunEvents", listRunEvents, []any{"run-x", now, "id-x", int32(200)}},
		{"queryWorkflowHealthSignals", queryWorkflowHealthSignals, []any{"org-x", "wf-x", now, nil, nil}},
		{"findOpenRecoveryItemForDebounce", findOpenRecoveryItemForDebounce, []any{"org-x", "wf-x", "sig-x", now}},
		{"getScimUserState", getScimUserState, []any{"dir-x", "user-x"}},
		{"findScimGroupRoleMappingByGroup", findScimGroupRoleMappingByGroup, []any{"org-x", "dir-x", "group-x"}},
		{"listScimUserGroupIDs", listScimUserGroupIDs, []any{"org-x", "dir-x", "user-x"}},
		{"listActiveScimUserState", listActiveScimUserState, []any{"org-x", "dir-x", int32(5001)}},
		{"listScheduleFireHistory", listScheduleFireHistory, []any{"wf-x", "org-x", now}},
		{"listFailedRunNodeSamples", listFailedRunNodeSamples, []any{"org-x", now}},
	}
	requiredIndexes := map[string]string{
		"listFailedRunNodeSamples": "run_nodes_failed_finished_idx",
	}

	for index, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatalf("begin: %v", err)
			}
			defer func() { _ = tx.Rollback(ctx) }()
			if _, err := tx.Exec(ctx, "SET LOCAL enable_seqscan = off"); err != nil {
				t.Fatalf("seqscan off: %v", err)
			}
			if requiredIndexes[c.name] != "" {
				// The controlled tenant key intentionally has no rows. PostgreSQL may
				// therefore choose the equally index-served per-run nested-loop path
				// (`runs_org_*` + `run_nodes_run_node_idx`) and never expose whether
				// the global failed-row path is viable. Disable that alternative only
				// for the explicit index-capability probe; the ordinary hot-query gate
				// above still accepts whichever non-sequential production plan is
				// cheapest for current statistics.
				if _, err := tx.Exec(ctx, "SET LOCAL enable_nestloop = off"); err != nil {
					t.Fatalf("nested loop off: %v", err)
				}
			}
			stmt := fmt.Sprintf("explain_probe_%d", index)
			if _, err := tx.Exec(ctx, fmt.Sprintf("PREPARE %s AS %s", stmt, c.sql)); err != nil {
				t.Fatalf("prepare: %v", err)
			}
			// EXECUTE args cannot ride the extended protocol as binds —
			// inline the CONTROLLED dummy values as SQL literals.
			literals := ""
			for i, arg := range c.args {
				if i > 0 {
					literals += ","
				}
				switch value := arg.(type) {
				case nil:
					literals += "NULL"
				case string:
					literals += "'" + value + "'"
				case int32:
					literals += fmt.Sprintf("%d", value)
				default:
					t.Fatalf("unsupported literal type %T", arg)
				}
			}
			var planJSON []byte
			row := tx.QueryRow(ctx,
				fmt.Sprintf("EXPLAIN (FORMAT JSON) EXECUTE %s(%s)", stmt, literals))
			if err := row.Scan(&planJSON); err != nil {
				t.Fatalf("explain: %v", err)
			}
			var parsed []map[string]any
			if err := json.Unmarshal(planJSON, &parsed); err != nil {
				t.Fatalf("plan json: %v", err)
			}
			var offenders []string
			var indexes []string
			walkPlan(parsed[0]["Plan"].(map[string]any), func(node map[string]any) {
				if node["Node Type"] == "Seq Scan" {
					if rel, _ := node["Relation Name"].(string); watchedTables[rel] {
						offenders = append(offenders, rel)
					}
				}
				if name, _ := node["Index Name"].(string); name != "" {
					indexes = append(indexes, name)
				}
			})
			if len(offenders) > 0 {
				t.Fatalf("no index can serve %s over %v (seq scan survives enable_seqscan=off)", c.name, offenders)
			}
			if required := requiredIndexes[c.name]; required != "" && !slices.Contains(indexes, required) {
				t.Fatalf("%s did not use required index %s: %v", c.name, required, indexes)
			}
		})
	}
}

func walkPlan(node map[string]any, visit func(map[string]any)) {
	visit(node)
	if children, ok := node["Plans"].([]any); ok {
		for _, child := range children {
			walkPlan(child.(map[string]any), visit)
		}
	}
}
