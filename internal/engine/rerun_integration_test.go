//go:build integration

package engine

import (
	"errors"
	"testing"

	"github.com/johnny4young/janusly/internal/store"
)

// The plan reads the source before the start transaction, so a redrive can land
// between them: the start must see it under the lock redrive also takes.
func TestStartRunRefusesARerunOfARevivedSource(t *testing.T) {
	ctx, _, eng, org := newHarness(t)
	wf := mustParse(t, linearDoc)
	sourceRunID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
	if err != nil {
		t.Fatalf("start source: %v", err)
	}
	_, err = eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf, Rerun: &RerunSeed{
		SourceRunID: sourceRunID, NodeID: wf.Nodes[0].ID, Nodes: map[string]NodeSeed{},
	}})
	if !errors.Is(err, ErrRerunSourceOpen) {
		t.Fatalf("a source still running must refuse the rerun: %v", err)
	}
}

// A redrive can settle again between planning and the start: the run looks
// terminal, but the plan was made from a row that has since moved.
func TestStartRunRefusesARerunPlannedFromAMovedRow(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	wf := mustParse(t, linearDoc)
	sourceRunID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
	if err != nil {
		t.Fatalf("start source: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE runs SET status='failed' WHERE id=$1`, sourceRunID); err != nil {
		t.Fatalf("settle run: %v", err)
	}
	nodeID := wf.Nodes[0].ID
	if _, err := pool.Exec(ctx, `UPDATE run_nodes SET status='failed', attempts=1, finished_at=now() WHERE run_id=$1 AND node_id=$2`, sourceRunID, nodeID); err != nil {
		t.Fatalf("settle node: %v", err)
	}
	plan := func() *RerunSeed {
		rows, err := store.New(pool).ListRunNodesByRunForOrg(ctx, store.ListRunNodesByRunForOrgParams{RunID: sourceRunID, OrgID: org})
		if err != nil {
			t.Fatalf("rows: %v", err)
		}
		planned, rejected := PlanRerun(sourceRunID, wf, rows, nodeID)
		if rejected != nil {
			t.Fatalf("plan: %+v", rejected)
		}
		return planned.Seed
	}
	start := func(seed *RerunSeed) error {
		_, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf, Rerun: seed})
		return err
	}
	for name, move := range map[string]string{
		"attempts":    `UPDATE run_nodes SET attempts=attempts+1 WHERE run_id=$1 AND node_id=$2`,
		"finished_at": `UPDATE run_nodes SET finished_at=finished_at+interval '1 second' WHERE run_id=$1 AND node_id=$2`,
	} {
		seed := plan()
		if _, err := pool.Exec(ctx, move, sourceRunID, nodeID); err != nil {
			t.Fatalf("move %s: %v", name, err)
		}
		if err := start(seed); !errors.Is(err, ErrRerunSourceOpen) {
			t.Fatalf("a moved %s must refuse the rerun: %v", name, err)
		}
	}
	if err := start(plan()); err != nil {
		t.Fatalf("a current plan must start: %v", err)
	}
}
