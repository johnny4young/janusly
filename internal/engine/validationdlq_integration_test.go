//go:build integration

package engine

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/store"
)

// A sandbox validation's failure is evidence for its dialog or drill —
// never operator work. The dead letter must exist for direct-by-id reads,
// carry the run's replay mode, open no incident, and stay out of the
// operator queue listing.
func TestValidationFailureDoesNotBecomeOperatorWork(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)

	runID := "run-valdlq-" + org
	if _, err := pool.Exec(ctx, `INSERT INTO runs
		(id, org_id, status, input_json, workflow_version_id, replay_mode)
		VALUES ($1, $2, 'running',
		 '{"workflow":{"id":"wf-valdlq","dslVersion":"1.0","nodes":[{"id":"fetch","type":"http","config":{"url":"https://x.invalid"}}],"edges":[]},"input":{}}',
		 'wv-valdlq', 'validation')`, runID, org); err != nil {
		t.Fatalf("seed validation run: %v", err)
	}
	var rowID string
	if err := pool.QueryRow(ctx, `INSERT INTO run_nodes
		(id, run_id, node_id, status, attempts, state_json)
		VALUES ($1, $2, 'fetch', 'running', 1, '{}') RETURNING id`,
		runID+"-fetch", runID).Scan(&rowID); err != nil {
		t.Fatalf("seed node: %v", err)
	}

	claim := ClaimedNode{RowID: rowID, RunID: runID, NodeID: "fetch", Attempt: 1}
	if err := eng.FailNode(ctx, claim, errors.New("deliberate validation failure")); err != nil {
		t.Fatalf("fail node: %v", err)
	}

	var replayMode pgtype.Text
	var dlqID string
	if err := pool.QueryRow(ctx,
		`SELECT id, replay_mode FROM dead_letters WHERE run_id = $1`, runID).
		Scan(&dlqID, &replayMode); err != nil {
		t.Fatalf("the dead letter must still exist for direct reads: %v", err)
	}
	if !replayMode.Valid || replayMode.String != "validation" {
		t.Fatalf("dead letter must carry the run's replay mode, got %+v", replayMode)
	}

	var incidents int
	_ = pool.QueryRow(ctx,
		`SELECT count(*) FROM recovery_items WHERE org_id = $1 AND dead_letter_id = $2`,
		org, dlqID).Scan(&incidents)
	if incidents != 0 {
		t.Fatalf("a dry-run must not open an incident, got %d", incidents)
	}

	rows, err := store.New(pool).ListDeadLetterSummaries(ctx, store.ListDeadLetterSummariesParams{
		OrgID: org, PageLimit: 50,
	})
	if err != nil {
		t.Fatalf("list summaries: %v", err)
	}
	for _, row := range rows {
		if row.ID == dlqID {
			t.Fatal("the operator queue listing must exclude validation-mode rows")
		}
	}
}
