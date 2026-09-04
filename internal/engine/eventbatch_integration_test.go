//go:build integration

package engine

import (
	"context"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/johnny4young/janusly/internal/store"
)

// Completion-family transactions land their timeline events in ONE
// CopyFrom round trip. The counter rides the wrapTx DI seam (the flakyTx
// precedent) and distinguishes per-row event INSERTs from bulk copies.

type countingTx struct {
	store.DBTX
	rowInserts *atomic.Int32
	copies     *atomic.Int32
	copiedRows *atomic.Int64
}

func (c *countingTx) Exec(ctx context.Context, sql string, args ...interface{}) (pgconn.CommandTag, error) {
	if strings.Contains(sql, "INSERT INTO run_events") {
		c.rowInserts.Add(1)
	}
	return c.DBTX.Exec(ctx, sql, args...)
}

func (c *countingTx) CopyFrom(ctx context.Context, table pgx.Identifier, columns []string, src pgx.CopyFromSource) (int64, error) {
	rows, err := c.DBTX.CopyFrom(ctx, table, columns, src)
	if table.Sanitize() == `"run_events"` {
		c.copies.Add(1)
		c.copiedRows.Add(rows)
	}
	return rows, err
}

func TestCompletionEventsLandInOneCopy(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	var rowInserts atomic.Int32
	var copies atomic.Int32
	var copiedRows atomic.Int64
	baseWrap := eng.wrapTx
	eng.wrapTx = func(tx store.DBTX) store.DBTX {
		return &countingTx{DBTX: baseWrap(tx), rowInserts: &rowInserts, copies: &copies, copiedRows: &copiedRows}
	}

	doc := `{"id":"wf-batch-` + fmt.Sprint(time.Now().UnixNano()) + `","name":"batch","dslVersion":"1.0",
		"nodes":[
			{"id":"a","type":"transform","config":{"mapping":{"v":"1"}}},
			{"id":"b","type":"noop","config":{}}
		],
		"edges":[{"from":"a","to":"b"}]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	// The start transaction lands its own timeline (run.started +
	// node.queued(a)) in one COPY as well.
	if rowInserts.Load() != 0 || copies.Load() != 1 || copiedRows.Load() != 2 {
		t.Fatalf("start must COPY its 2 initial events once: inserts=%d copies=%d rows=%d",
			rowInserts.Load(), copies.Load(), copiedRows.Load())
	}
	startCopies, startRows := copies.Load(), copiedRows.Load()
	runDispatcherToTerminal(t, eng, pool, runID, "succeeded")

	if rowInserts.Load() != 0 {
		t.Fatalf("completion path must not per-row insert events, saw %d", rowInserts.Load())
	}
	// Two completion transactions (node a, node b): each lands exactly one COPY.
	if completionCopies := copies.Load() - startCopies; completionCopies != 2 {
		t.Fatalf("expected 2 event copies (one per completion tx), got %d", completionCopies)
	}
	// a: node.succeeded + node.queued(b) = 2; b: node.succeeded + run.succeeded
	// + run.status_checked = 3 — five events, two round trips (was five).
	if completionRows := copiedRows.Load() - startRows; completionRows != 5 {
		t.Fatalf("expected 5 batched events across both completions, got %d", completionRows)
	}

	// The timeline itself is byte-compatible: exact vocabulary and order.
	events, err := store.New(pool).ListRunEventsAfter(ctx, store.ListRunEventsAfterParams{
		RunID: runID, AfterCreatedAt: time.Unix(0, 0), AfterID: "", PageLimit: 50,
	})
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	var kinds []string
	for _, event := range events {
		kinds = append(kinds, event.Type)
	}
	want := "run.started,node.queued,node.running,node.succeeded,node.queued,node.running,node.succeeded,run.succeeded,run.status_checked"
	if got := strings.Join(kinds, ","); got != want {
		t.Fatalf("event order drifted:\n got %s\nwant %s", got, want)
	}
}
