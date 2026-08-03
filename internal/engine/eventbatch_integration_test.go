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
	startInserts := rowInserts.Load() // the start tx keeps per-row inserts (out of scope)
	runDispatcherToTerminal(t, eng, pool, runID, "succeeded")

	completionInserts := rowInserts.Load() - startInserts
	if completionInserts != 0 {
		t.Fatalf("completion path must not per-row insert events, saw %d", completionInserts)
	}
	// Two completion transactions (node a, node b): each lands exactly one COPY.
	if copies.Load() != 2 {
		t.Fatalf("expected 2 event copies (one per completion tx), got %d", copies.Load())
	}
	// a: node.succeeded + node.queued(b) = 2; b: node.succeeded + run.succeeded
	// + run.status_checked = 3 — five events, two round trips (was five).
	if copiedRows.Load() != 5 {
		t.Fatalf("expected 5 batched events across both completions, got %d", copiedRows.Load())
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
