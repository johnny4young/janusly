//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

// Event insert throughput: one run per worker, every worker on one run, and
// the completion-family COPY of ten events.
func BenchmarkRunEventInsert(b *testing.B) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		b.Skip("JANUSLY_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		b.Fatalf("pool: %v", err)
	}
	b.Cleanup(pool.Close)
	eng := New(pool)
	org := fmt.Sprintf("org-bench-%d", time.Now().UnixNano())
	newRun := func() string {
		wf, issues := domain.Parse([]byte(linearDoc))
		if wf == nil {
			b.Fatalf("parse: %+v", issues)
		}
		runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
		if err != nil {
			b.Fatalf("start: %v", err)
		}
		if err := eng.CancelRun(ctx, runID, nil); err != nil {
			b.Fatalf("cancel: %v", err)
		}
		return runID
	}
	insert := func(q *store.Queries, runID string) error {
		at := time.Now()
		return q.InsertRunEventAt(ctx, store.InsertRunEventAtParams{
			ID: newEventID(), RunID: runID, OrgID: org,
			NodeID: pgtype.Text{String: "first", Valid: true},
			Type:   "node.tick", Payload: json.RawMessage(`{"attempt":1}`), CreatedAt: &at,
		})
	}
	const workers = 8
	b.Run("distinct-runs", func(b *testing.B) {
		runs := make([]string, workers)
		for index := range runs {
			runs[index] = newRun()
		}
		var next atomic.Int64
		b.SetParallelism(workers)
		b.RunParallel(func(pb *testing.PB) {
			runID := runs[int(next.Add(1)-1)%workers]
			q := store.New(pool)
			for pb.Next() {
				if err := insert(q, runID); err != nil {
					b.Error(err)
					return
				}
			}
		})
	})
	b.Run("one-run", func(b *testing.B) {
		runID := newRun()
		b.SetParallelism(workers)
		b.RunParallel(func(pb *testing.PB) {
			q := store.New(pool)
			for pb.Next() {
				if err := insert(q, runID); err != nil {
					b.Error(err)
					return
				}
			}
		})
	})
	b.Run("copy-10", func(b *testing.B) {
		runs := make([]string, workers)
		for index := range runs {
			runs[index] = newRun()
		}
		var next atomic.Int64
		b.SetParallelism(workers)
		b.RunParallel(func(pb *testing.PB) {
			runID := runs[int(next.Add(1)-1)%workers]
			for pb.Next() {
				err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
					at := time.Now()
					rows := make([]store.InsertRunEventsParams, 10)
					for index := range rows {
						rows[index] = store.InsertRunEventsParams{
							ID: newEventID(), RunID: runID, OrgID: org,
							NodeID: pgtype.Text{String: "first", Valid: true},
							Type:   "node.tick", Payload: json.RawMessage(`{}`), CreatedAt: &at,
						}
					}
					_, err := store.New(tx).InsertRunEvents(ctx, rows)
					return err
				})
				if err != nil {
					b.Error(err)
					return
				}
			}
		})
	})
}
