//go:build integration

package engine

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/domain"
)

// Go does not publish to BullMQ while it owns the work plane, but every
// queued generation keeps the reference runtime's Postgres publication
// marker current. A rollback can therefore restart Node's existing
// queue-publication reconciler without inventing or prematurely firing work.
func TestQueuedGenerationsRemainPublishableForNodeRollback(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID, err := eng.StartRun(ctx, StartInput{
		OrgID: org, Workflow: mustParse(t, linearDoc),
	})
	if err != nil {
		t.Fatalf("start: %v", err)
	}

	assertPublication := func(nodeID, status string, generation int, wantMarker bool) *time.Time {
		t.Helper()
		var gotStatus string
		var gotGeneration int
		var marker *time.Time
		if err := pool.QueryRow(ctx, `
			SELECT status, queue_publication_generation, queue_publication_repair_after
			FROM run_nodes WHERE run_id=$1 AND node_id=$2`, runID, nodeID).
			Scan(&gotStatus, &gotGeneration, &marker); err != nil {
			t.Fatalf("read %s publication state: %v", nodeID, err)
		}
		if gotStatus != status || gotGeneration != generation || (marker != nil) != wantMarker {
			t.Fatalf("%s publication state = status %s generation %d marker %v", nodeID, gotStatus, gotGeneration, marker)
		}
		return marker
	}
	prioritizeClaim := func(nodeID string, suffix byte) {
		t.Helper()
		compact := strings.ReplaceAll(runID, "-", "")
		rowID := fmt.Sprintf("00000000-0000-0000-0000-%011s%c", compact[len(compact)-11:], suffix)
		if _, err := pool.Exec(ctx, `UPDATE run_nodes SET id=$3 WHERE run_id=$1 AND node_id=$2`,
			runID, nodeID, rowID); err != nil {
			t.Fatalf("prioritize %s claim: %v", nodeID, err)
		}
	}

	// Initial roots are immediately repairable by Node; non-roots are not
	// executable and therefore carry no publication generation.
	assertPublication("first", "queued", 1, true)
	assertPublication("second", "pending", 0, false)

	prioritizeClaim("first", '1')
	claims, err := eng.claimBatch(ctx, 1)
	if err != nil || len(claims) != 1 || claims[0].RunID != runID || claims[0].NodeID != "first" {
		t.Fatalf("claim first: %+v err=%v", claims, err)
	}
	assertPublication("first", "running", 1, false)
	if err := eng.CompleteNode(ctx, claims[0], map[string]any{"ok": true}); err != nil {
		t.Fatalf("complete first: %v", err)
	}
	assertPublication("second", "queued", 1, true)

	prioritizeClaim("second", '2')
	claims, err = eng.claimBatch(ctx, 1)
	if err != nil || len(claims) != 1 || claims[0].RunID != runID || claims[0].NodeID != "second" {
		t.Fatalf("claim second: %+v err=%v", claims, err)
	}
	assertPublication("second", "running", 1, false)
	retryNode := domain.Node{
		ID: "second", Type: "noop",
		Config: map[string]any{"retry": map[string]any{"maxAttempts": float64(2), "delayMs": float64(60_000)}},
	}
	if err := eng.RetryOrFail(ctx, claims[0], retryNode, errors.New("retry me")); err != nil {
		t.Fatalf("retry: %v", err)
	}
	marker := assertPublication("second", "queued", 2, true)
	var wakeAt time.Time
	var reason string
	if err := pool.QueryRow(ctx, `
		SELECT w.wake_at, w.reason FROM go_pilot_wakeups w
		JOIN run_nodes rn ON rn.id=w.run_node_id
		WHERE rn.run_id=$1 AND rn.node_id='second'`, runID).Scan(&wakeAt, &reason); err != nil {
		t.Fatalf("read retry clock: %v", err)
	}
	if reason != "retry" || marker == nil || !wakeAt.Equal(*marker) {
		t.Fatalf("rollback marker must equal retry clock: marker=%v wake=%s reason=%s", marker, wakeAt, reason)
	}
}
