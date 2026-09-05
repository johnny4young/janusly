//go:build integration

package engine

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/johnny4young/janusly/internal/store"
)

// Rows under a run carry the run's tenant: the start path stamps them, any
// other insert is stamped from the run row, a row for an unknown run cannot
// exist, and tenant-scoped reads never cross organizations.
func TestRunRowsCarryTheRunsOrganization(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, linearDoc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	var nodes, events, foreign int
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM run_nodes WHERE run_id=$1 AND org_id=$2),
		(SELECT count(*) FROM run_events WHERE run_id=$1 AND org_id=$2),
		(SELECT count(*) FROM run_nodes WHERE run_id=$1 AND org_id<>$2)
		+ (SELECT count(*) FROM run_events WHERE run_id=$1 AND org_id<>$2)`, runID, org).Scan(&nodes, &events, &foreign); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	if nodes != 2 || events == 0 || foreign != 0 {
		t.Fatalf("start must stamp every row with the run's org: nodes=%d events=%d foreign=%d", nodes, events, foreign)
	}

	if _, err := pool.Exec(ctx, `INSERT INTO run_events (id, run_id, type, payload) VALUES ($1, $2, 'test.stamped', '{}')`, runID+"-stamped", runID); err != nil {
		t.Fatalf("insert without org: %v", err)
	}
	var stamped string
	if err := pool.QueryRow(ctx, `SELECT org_id FROM run_events WHERE id=$1`, runID+"-stamped").Scan(&stamped); err != nil || stamped != org {
		t.Fatalf("an insert that omits the tenant must be stamped from the run: got %q err=%v", stamped, err)
	}

	_, err = pool.Exec(ctx, `INSERT INTO run_nodes (id, run_id, node_id, status) VALUES ($1, 'run-that-does-not-exist', 'x', 'pending')`, runID+"-orphan")
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23502" {
		t.Fatalf("a row for an unknown run must be refused (not-null on org_id), got %v", err)
	}

	q := store.New(pool)
	own, err := q.ListRunNodesByRunForOrg(ctx, store.ListRunNodesByRunForOrgParams{RunID: runID, OrgID: org})
	if err != nil || len(own) != 2 {
		t.Fatalf("tenant-scoped read of own run: rows=%d err=%v", len(own), err)
	}
	other, err := q.ListRunNodesByRunForOrg(ctx, store.ListRunNodesByRunForOrgParams{RunID: runID, OrgID: org + "-other"})
	if err != nil || len(other) != 0 {
		t.Fatalf("a run id alone must not expose another organization's rows: rows=%d err=%v", len(other), err)
	}
}
