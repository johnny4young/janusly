//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/store"
)

// failingTx makes every statement inside a completion transaction fail — the
// shape of a transient PostgreSQL error landing mid-repair.
type failingTx struct{ store.DBTX }

var errInjected = errors.New("injected transaction failure")

func (f failingTx) Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, errInjected
}
func (f failingTx) Query(context.Context, string, ...interface{}) (pgx.Rows, error) {
	return nil, errInjected
}
func (f failingTx) QueryRow(context.Context, string, ...interface{}) pgx.Row { return errRow{} }
func (f failingTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, errInjected
}

type errRow struct{}

func (errRow) Scan(...any) error { return errInjected }

// The crash-window recheck: the parent node is already `succeeded` for this
// exact child (the CAS misses), the parent run is still running, and the
// downstream schedule is the repair. When that repair's transaction fails,
// the handoff is NOT settled — the durable marker must survive so the next
// lease retries it. Before this test the failure was discarded, "settled" was
// reported, and the reconciler cleared the marker: the parent stayed running
// forever with nothing left to retry from.
func TestSubworkflowRepairKeepsMarkerWhenTransactionFails(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	q := store.New(pool)
	suffix := fmt.Sprint(time.Now().UnixNano())

	childID := "wf-repairfail-child-" + suffix
	saveWorkflowVersion(t, ctx, q, org, childID, `{"id":"`+childID+`","name":"child","dslVersion":"1.0",
		"nodes":[{"id":"work","type":"noop","config":{}}],"edges":[]}`)
	parentDoc := `{"id":"wf-repairfail-parent-` + suffix + `","name":"parent","dslVersion":"1.0",
		"nodes":[{"id":"call","type":"subworkflow","config":{"workflowId":"` + childID + `"}},
		         {"id":"after","type":"noop","config":{}}],
		"edges":[{"from":"call","to":"after"}]}`
	parentRunID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, parentDoc)})
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	runDispatcherToTerminal(t, eng, pool, parentRunID, "succeeded")
	var childRunID string
	if err := pool.QueryRow(ctx, `SELECT id FROM runs WHERE parent_run_id = $1`, parentRunID).Scan(&childRunID); err != nil {
		t.Fatalf("child run: %v", err)
	}

	// Recheck shape: node already succeeded for this child, parent reopened
	// and still running, marker armed.
	state, _ := json.Marshal(map[string]any{"output": map[string]any{}, "subworkflow": map[string]any{"childRunId": childRunID}})
	if _, err := pool.Exec(ctx,
		`UPDATE run_nodes SET status = 'succeeded', state_json = $1 WHERE run_id = $2 AND node_id = 'call'`,
		state, parentRunID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE run_nodes SET status = 'queued', started_at = NULL, finished_at = NULL WHERE run_id = $1 AND node_id = 'after'`, parentRunID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE runs SET status = 'running', output_json = NULL WHERE id = $1`, parentRunID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE runs SET parent_notification_after = now() - interval '5 minutes' WHERE id = $1`, childRunID); err != nil {
		t.Fatal(err)
	}

	// First pass: the repair transaction fails.
	baseWrap := eng.wrapTx
	eng.wrapTx = func(tx store.DBTX) store.DBTX { return failingTx{DBTX: baseWrap(tx)} }
	scanned, repaired, err := eng.ReconcileSubworkflowTerminals(ctx)
	if err != nil {
		t.Fatalf("claim itself must succeed: %v", err)
	}
	if scanned < 1 || repaired != 0 {
		t.Fatalf("a failed repair must not count as repaired: scanned=%d repaired=%d", scanned, repaired)
	}
	var marker pgtype.Timestamptz
	_ = pool.QueryRow(ctx, `SELECT parent_notification_after FROM runs WHERE id = $1`, childRunID).Scan(&marker)
	if !marker.Valid {
		t.Fatal("marker must survive a failed repair so the next lease retries it")
	}

	// Second pass, once the lease lapses and the fault is gone: the repair lands.
	eng.wrapTx = baseWrap
	if _, err := pool.Exec(ctx, `UPDATE runs SET parent_notification_after = now() - interval '5 minutes' WHERE id = $1`, childRunID); err != nil {
		t.Fatal(err)
	}
	if _, repaired, err = eng.ReconcileSubworkflowTerminals(ctx); err != nil || repaired != 1 {
		t.Fatalf("healthy retry must repair exactly once: repaired=%d err=%v", repaired, err)
	}
	_ = pool.QueryRow(ctx, `SELECT parent_notification_after FROM runs WHERE id = $1`, childRunID).Scan(&marker)
	if marker.Valid {
		t.Fatal("settled marker must clear after the successful retry")
	}
}
