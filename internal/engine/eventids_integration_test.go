//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/store"
)

// Events stamped with the same millisecond read back in the order their ids
// were generated, even when they are inserted in the opposite order.
func TestSameMillisecondRunEventsReadInGenerationOrder(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, linearDoc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	// A queued run left behind would be claimed by later worker tests.
	if err := eng.CancelRun(ctx, runID, nil); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	at := time.Now().Add(time.Hour).UTC().Truncate(time.Millisecond)
	generated := make([]string, 20)
	for index := range generated {
		generated[index] = newEventID()
	}
	q := store.New(pool)
	for _, id := range slices.Backward(generated) {
		if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
			ID: id, RunID: runID, OrgID: org,
			NodeID: pgtype.Text{String: "first", Valid: true},
			Type:   "node.tick", Payload: json.RawMessage(`{}`), CreatedAt: &at,
		}); err != nil {
			t.Fatalf("insert: %v", err)
		}
	}
	rows, err := q.ListRunEventsForOrg(ctx, store.ListRunEventsForOrgParams{
		RunID: runID, OrgID: org, BeforeCreatedAt: at.Add(time.Millisecond), BeforeID: "", PageLimit: int32(len(generated)),
	})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	var read []string
	for _, row := range slices.Backward(rows) {
		read = append(read, row.ID)
	}
	if !slices.Equal(read, generated) {
		t.Fatalf("same-millisecond events out of generation order:\n got %v\nwant %v", read, generated)
	}
}

func startCancelledRun(t *testing.T, ctx context.Context, eng *Engine, org string) string {
	t.Helper()
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, linearDoc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if err := eng.CancelRun(ctx, runID, nil); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	return runID
}

func runEventSeqs(t *testing.T, ctx context.Context, q *store.Queries, org, runID string) ([]int64, map[string]int64) {
	t.Helper()
	rows, err := q.ListRunEventsAfterSeqForOrg(ctx, store.ListRunEventsAfterSeqForOrgParams{
		RunID: runID, OrgID: org, AfterSeq: 0, PageLimit: 100,
	})
	if err != nil {
		t.Fatalf("list by seq: %v", err)
	}
	seqs := make([]int64, 0, len(rows))
	byID := map[string]int64{}
	for _, row := range rows {
		seqs = append(seqs, row.Seq)
		byID[row.ID] = row.Seq
	}
	return seqs, byID
}

// Every insert path, COPY and raw SQL included, takes the run's next position.
func TestRunEventSequenceCoversEveryInsertPath(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID := startCancelledRun(t, ctx, eng, org)
	q := store.New(pool)
	node := pgtype.Text{String: "first", Valid: true}
	at := time.Now()
	ids := []string{newEventID(), newEventID(), newEventID(), newEventID(), newEventID()}
	if err := q.InsertRunEvent(ctx, store.InsertRunEventParams{
		ID: ids[0], RunID: runID, OrgID: org, NodeID: node, Type: "node.tick", Payload: json.RawMessage(`{}`),
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	if err := q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
		ID: ids[1], RunID: runID, OrgID: org, NodeID: node, Type: "node.tick", Payload: json.RawMessage(`{}`), CreatedAt: &at,
	}); err != nil {
		t.Fatalf("insert at: %v", err)
	}
	if _, err := q.InsertRunEvents(ctx, []store.InsertRunEventsParams{
		{ID: ids[2], RunID: runID, OrgID: org, NodeID: node, Type: "node.tick", Payload: json.RawMessage(`{}`), CreatedAt: &at},
		{ID: ids[3], RunID: runID, OrgID: org, NodeID: node, Type: "node.tick", Payload: json.RawMessage(`{}`), CreatedAt: &at},
	}); err != nil {
		t.Fatalf("copy: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO run_events (id, run_id, type, seq) VALUES ($1, $2, 'node.tick', 999)`, ids[4], runID); err != nil {
		t.Fatalf("raw insert: %v", err)
	}

	seqs, byID := runEventSeqs(t, ctx, q, org, runID)
	for index, seq := range seqs {
		if seq != int64(index+1) {
			t.Fatalf("run event seqs must be 1..n without gaps: %v", seqs)
		}
	}
	last := int64(len(seqs))
	for index, id := range ids {
		if want := last - int64(len(ids)-1-index); byID[id] != want {
			t.Fatalf("event %d took seq %d, want %d (all: %v)", index, byID[id], want, seqs)
		}
	}
}

// A later insert into the same run waits for the earlier transaction, so the
// higher seq always commits later; another run's insert does not wait.
func TestRunEventSequenceFollowsCommitOrder(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID := startCancelledRun(t, ctx, eng, org)
	otherRunID := startCancelledRun(t, ctx, eng, org)
	insert := func(db store.DBTX, run, id string) error {
		at := time.Now()
		return store.New(db).InsertRunEventAt(ctx, store.InsertRunEventAtParams{
			ID: id, RunID: run, OrgID: org, NodeID: pgtype.Text{String: "first", Valid: true},
			Type: "node.tick", Payload: json.RawMessage(`{}`), CreatedAt: &at,
		})
	}
	firstID, secondID := newEventID(), newEventID()
	first, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer func() { _ = first.Rollback(ctx) }()
	if err := insert(first, runID, firstID); err != nil {
		t.Fatalf("first insert: %v", err)
	}

	otherCtx, cancelOther := context.WithTimeout(ctx, 5*time.Second)
	defer cancelOther()
	otherAt := time.Now()
	if err := store.New(pool).InsertRunEventAt(otherCtx, store.InsertRunEventAtParams{
		ID: newEventID(), RunID: otherRunID, OrgID: org, Type: "node.tick", Payload: json.RawMessage(`{}`), CreatedAt: &otherAt,
	}); err != nil {
		t.Fatalf("another run's insert must not wait for this run's open transaction: %v", err)
	}

	secondPID := make(chan uint32, 1)
	secondDone := make(chan error, 1)
	go func() {
		secondDone <- pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
			secondPID <- tx.Conn().PgConn().PID()
			return insert(tx, runID, secondID)
		})
	}()
	pid := <-secondPID
	deadline := time.Now().Add(10 * time.Second)
	for {
		var waitType *string
		if err := pool.QueryRow(ctx, `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, pid).Scan(&waitType); err != nil {
			t.Fatalf("inspect second transaction: %v", err)
		}
		if waitType != nil && *waitType == "Lock" {
			break
		}
		select {
		case err := <-secondDone:
			t.Fatalf("second insert committed while the first transaction was open: %v", err)
		case <-time.After(20 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			t.Fatal("second insert never waited for the first transaction")
		}
	}
	if err := first.Commit(ctx); err != nil {
		t.Fatalf("commit first: %v", err)
	}
	if err := <-secondDone; err != nil {
		t.Fatalf("second insert: %v", err)
	}
	_, byID := runEventSeqs(t, ctx, store.New(pool), org, runID)
	if byID[firstID] == 0 || byID[secondID] != byID[firstID]+1 {
		t.Fatalf("commit order must match seq: first=%d second=%d", byID[firstID], byID[secondID])
	}
}
