//go:build integration

package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestTextSearchContractIsUnicodeLiteralTenantScopedAndPaginated(t *testing.T) {
	h := newAPIHarnessWithoutWorkers(t)
	pool := testPool(t)
	ctx := context.Background()
	suffix := fmt.Sprint(time.Now().UnixNano())
	otherOrg := h.org + "-other"
	now := time.Now().UTC().Truncate(time.Millisecond)

	workflowIDs := []string{"wf-search-new-" + suffix, "wf-search-old-" + suffix}
	for index, id := range workflowIDs {
		if _, err := pool.Exec(ctx, `INSERT INTO workflows (id, org_id, name, created_by, created_at)
			VALUES ($1, $2, $3, 'search-test', $4)`, id, h.org,
			"Factura café abc%_\\ needle "+fmt.Sprint(index), now.Add(-time.Duration(index)*time.Minute)); err != nil {
			t.Fatalf("seed workflow: %v", err)
		}
	}
	otherWorkflow := "wf-search-other-" + suffix
	if _, err := pool.Exec(ctx, `INSERT INTO workflows (id, org_id, name, created_by, created_at)
		VALUES ($1, $2, 'Factura café abc%_\\ needle other tenant', 'search-test', $3)`,
		otherWorkflow, otherOrg, now.Add(time.Minute)); err != nil {
		t.Fatalf("seed other workflow: %v", err)
	}

	workflowPage := func(path string) []any {
		t.Helper()
		res := h.call("GET", path, nil, "")
		if res.status != 200 {
			t.Fatalf("workflow search %s: %d %+v", path, res.status, res.body)
		}
		return res.body["data"].([]any)
	}
	first := workflowPage("/v1/workflows?limit=1&q=" + url.QueryEscape("café"))
	if len(first) != 1 || first[0].(map[string]any)["id"] != workflowIDs[0] {
		t.Fatalf("workflow page 1: %+v", first)
	}
	firstRow := first[0].(map[string]any)
	cursor := fmt.Sprint(firstRow["createdAt"]) + "|" + fmt.Sprint(firstRow["id"])
	second := workflowPage("/v1/workflows?limit=1&q=" + url.QueryEscape("café") + "&before=" + url.QueryEscape(cursor))
	if len(second) != 1 || second[0].(map[string]any)["id"] != workflowIDs[1] {
		t.Fatalf("workflow page 2 or tenant isolation: %+v", second)
	}
	literal := workflowPage("/v1/workflows?q=" + url.QueryEscape(`abc%_\`))
	if len(literal) != 2 {
		t.Fatalf("literal workflow metacharacters must match only tenant rows: %+v", literal)
	}
	idMatch := workflowPage("/v1/workflows?q=" + url.QueryEscape("search-old"))
	if len(idMatch) != 1 || idMatch[0].(map[string]any)["id"] != workflowIDs[1] {
		t.Fatalf("workflow id search: %+v", idMatch)
	}

	for _, test := range []struct {
		path string
		code string
	}{
		{path: "/v1/workflows?q=ab", code: "search_query_too_short"},
		{path: "/v1/workflows?q=" + url.QueryEscape(`%_\`), code: "search_query_too_short"},
		{path: "/v1/workflows?q=" + url.QueryEscape(strings.Repeat("界", 101)), code: "search_query_too_long"},
		{path: "/v1/workflows?q=" + url.QueryEscape("abc\x1fdef"), code: "search_query_invalid_characters"},
		{path: "/v1/workflows?q=%FFabc", code: "search_query_invalid_utf8"},
	} {
		requireError(t, h.call("GET", test.path, nil, ""), 400, test.code, "")
	}
	if rows := workflowPage("/v1/workflows?q="); len(rows) != 2 {
		t.Fatalf("empty workflow query must mean no filter: %+v", rows)
	}

	deadLetterIDs := []string{"dl-search-new-" + suffix, "dl-search-old-" + suffix}
	for index, id := range deadLetterIDs {
		seedQueueDeadLetter(t, h.org, id, "open", "Fallo café abc%_\\ needle "+fmt.Sprint(index),
			now.Add(-time.Duration(index)*time.Minute))
	}
	seedQueueDeadLetter(t, otherOrg, "dl-search-other-"+suffix, "open", "Fallo café abc%_\\ needle other", now.Add(time.Minute))

	res := h.call("GET", "/dlq/queue?limit=1&search="+url.QueryEscape("café"), nil, "")
	if res.status != 200 || res.body["hasMore"] != true {
		t.Fatalf("recovery page 1: %d %+v", res.status, res.body)
	}
	if ids := queueItemIDs(t, res.body); len(ids) != 1 || ids[0] != deadLetterIDs[0] {
		t.Fatalf("recovery page 1 ids: %v", ids)
	}
	next := res.body["nextCursor"].(string)
	res = h.call("GET", "/dlq/queue?limit=1&search="+url.QueryEscape("café")+"&cursor="+url.QueryEscape(next), nil, "")
	if ids := queueItemIDs(t, res.body); len(ids) != 1 || ids[0] != deadLetterIDs[1] {
		t.Fatalf("recovery page 2 or tenant isolation: %v", ids)
	}
	res = h.call("GET", "/dlq/queue?search="+url.QueryEscape(`abc%_\`), nil, "")
	if ids := queueItemIDs(t, res.body); len(ids) != 2 {
		t.Fatalf("literal recovery metacharacters: %v", ids)
	}
	res = h.call("GET", "/dlq/queue?search="+url.QueryEscape("search-old"), nil, "")
	if ids := queueItemIDs(t, res.body); len(ids) != 1 || ids[0] != deadLetterIDs[1] {
		t.Fatalf("recovery node/run id search: %v", ids)
	}
	for _, test := range []struct {
		path string
		code string
	}{
		{path: "/dlq/queue?search=ab", code: "search_query_too_short"},
		{path: "/dlq/queue?search=" + url.QueryEscape(`%_\`), code: "search_query_too_short"},
		{path: "/dlq/queue?search=" + url.QueryEscape(strings.Repeat("界", 101)), code: "search_query_too_long"},
		{path: "/dlq/queue?search=" + url.QueryEscape("abc\x1fdef"), code: "search_query_invalid_characters"},
		{path: "/dlq/queue?search=%FFabc", code: "search_query_invalid_utf8"},
	} {
		got := h.call("GET", test.path, nil, "")
		if got.status != 400 || got.body["code"] != test.code {
			t.Fatalf("recovery error %s: %d %+v", test.path, got.status, got.body)
		}
	}
	if got := h.call("GET", "/dlq/queue?search=", nil, ""); got.status != 200 || len(queueItemIDs(t, got.body)) != 2 {
		t.Fatalf("empty recovery query must mean no filter: %d %+v", got.status, got.body)
	}
}

func TestTextSearchProductionPredicatesUseBoundedCombinedIndexes(t *testing.T) {
	pool := testPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	const rows = 50_000
	org := fmt.Sprintf("search-plan-%d", time.Now().UnixNano())
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), time.Minute)
		defer cleanupCancel()
		if _, err := pool.Exec(cleanupCtx, `DELETE FROM dead_letters WHERE org_id = $1`, org); err != nil {
			t.Errorf("clean recovery plan rows: %v", err)
		}
		if _, err := pool.Exec(cleanupCtx, `DELETE FROM workflows WHERE org_id = $1`, org); err != nil {
			t.Errorf("clean workflow plan rows: %v", err)
		}
		if _, err := pool.Exec(cleanupCtx, `VACUUM (ANALYZE) workflows`); err != nil {
			t.Errorf("vacuum workflows after plan fixture: %v", err)
		}
		if _, err := pool.Exec(cleanupCtx, `VACUUM (ANALYZE) dead_letters`); err != nil {
			t.Errorf("vacuum dead letters after plan fixture: %v", err)
		}
	})
	if _, err := pool.Exec(ctx, `INSERT INTO workflows (id, org_id, name, created_by, created_at)
		SELECT 'plan-workflow-' || gs, $1,
		       CASE WHEN gs = $2 THEN 'Unique workflow-plan-needle café' ELSE md5(gs::text) END,
		       'search-plan', timestamptz '2026-01-01' + gs * interval '1 millisecond'
		FROM generate_series(1, $2::int) AS gs`, org, rows); err != nil {
		t.Fatalf("seed workflow plan rows: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO dead_letters
		(id, org_id, run_id, node_id, attempt, workflow_json, node_json, error_json, status, created_at)
		SELECT 'plan-dead-letter-' || gs, $1, 'plan-run-' || gs, 'plan-node-' || gs, 1,
		       '{}'::jsonb, '{}'::jsonb,
		       jsonb_build_object('message', CASE WHEN gs = $2 THEN 'Unique recovery-plan-needle café' ELSE md5(gs::text) END),
		       'open', timestamptz '2026-01-01' + gs * interval '1 millisecond'
		FROM generate_series(1, $2::int) AS gs`, org, rows); err != nil {
		t.Fatalf("seed recovery plan rows: %v", err)
	}
	// Qualify the steady-state planner posture after the GIN fast-update pending
	// lists are flushed. Production autovacuum performs the same maintenance;
	// leaving the fixture only in a pending list would measure ingestion, not
	// the index Janusly relies on for operator reads.
	for _, index := range []string{"workflows_active_search_trgm_idx", "dead_letters_recovery_search_trgm_idx"} {
		var cleaned int64
		if err := pool.QueryRow(ctx, `SELECT gin_clean_pending_list($1::regclass)`, index).Scan(&cleaned); err != nil {
			t.Fatalf("clean pending list %s: %v", index, err)
		}
	}
	if _, err := pool.Exec(ctx, `VACUUM (ANALYZE) workflows`); err != nil {
		t.Fatalf("vacuum workflows: %v", err)
	}
	if _, err := pool.Exec(ctx, `VACUUM (ANALYZE) dead_letters`); err != nil {
		t.Fatalf("vacuum dead letters: %v", err)
	}

	workflowPlan := explainSearchPlan(t, ctx, pool, `SELECT id FROM workflows
		WHERE org_id = $1 AND deleted_at IS NULL
		  AND (name || chr(31) || id) ILIKE $2 ESCAPE '\'
		ORDER BY created_at DESC, id DESC LIMIT 101`, org, "%workflow-plan-needle%")
	recoveryPlan := explainSearchPlan(t, ctx, pool, `SELECT id FROM dead_letters
		WHERE org_id = $1 AND replay_mode IS NULL
		  AND (node_id || chr(31) || run_id || chr(31) || COALESCE(error_json->>'message', '')) ILIKE $2 ESCAPE '\'
		ORDER BY created_at DESC, id DESC LIMIT 201`, org, "%recovery-plan-needle%")
	if !slices.Contains(workflowPlan, "workflows_active_search_trgm_idx") {
		t.Fatalf("workflow search did not use combined trigram index: %v", workflowPlan)
	}
	if !slices.Contains(recoveryPlan, "dead_letters_recovery_search_trgm_idx") {
		t.Fatalf("recovery search did not use combined trigram index: %v", recoveryPlan)
	}
}

type searchPlanQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func explainSearchPlan(t *testing.T, ctx context.Context, db searchPlanQuerier, query, org, pattern string) []string {
	t.Helper()
	var raw []byte
	if err := db.QueryRow(ctx, `EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF, SUMMARY ON) `+query, org, pattern).Scan(&raw); err != nil {
		t.Fatalf("explain search: %v", err)
	}
	var envelope []map[string]any
	if err := json.Unmarshal(raw, &envelope); err != nil || len(envelope) != 1 {
		t.Fatalf("decode explain plan: %v %s", err, raw)
	}
	root, ok := envelope[0]["Plan"].(map[string]any)
	if !ok {
		t.Fatalf("explain plan missing root: %s", raw)
	}
	indexes := make([]string, 0, 2)
	var walk func(map[string]any)
	walk = func(node map[string]any) {
		if name, _ := node["Index Name"].(string); name != "" {
			indexes = append(indexes, name)
		}
		children, _ := node["Plans"].([]any)
		for _, child := range children {
			if typed, ok := child.(map[string]any); ok {
				walk(typed)
			}
		}
	}
	walk(root)
	slices.Sort(indexes)
	return slices.Compact(indexes)
}
