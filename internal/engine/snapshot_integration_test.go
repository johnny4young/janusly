//go:build integration

package engine

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
)

// queryCounter counts sqlc-named statements as the pool issues them, so a
// test can assert how many times a node cycle transferred the run snapshot.
type queryCounter struct {
	mu     sync.Mutex
	counts map[string]int
}

func (c *queryCounter) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if name, ok := strings.CutPrefix(data.SQL, "-- name: "); ok {
		name, _, _ = strings.Cut(name, " ")
		c.mu.Lock()
		if c.counts == nil {
			c.counts = map[string]int{}
		}
		c.counts[name]++
		c.mu.Unlock()
	}
	return ctx
}

func (c *queryCounter) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// COPY statements bypass the query tracer; they are counted by table.
func (c *queryCounter) TraceCopyFromStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceCopyFromStartData) context.Context {
	c.mu.Lock()
	if c.counts == nil {
		c.counts = map[string]int{}
	}
	c.counts["copy:"+strings.Trim(data.TableName.Sanitize(), `"`)]++
	c.mu.Unlock()
	return ctx
}

func (c *queryCounter) TraceCopyFromEnd(context.Context, *pgx.Conn, pgx.TraceCopyFromEndData) {}

func (c *queryCounter) reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.counts = map[string]int{}
}

func (c *queryCounter) get(name string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.counts[name]
}

const chainDoc = `{"nodes":[
	{"id":"a","type":"transform","config":{"mapping":{"step":"a"}}},
	{"id":"b","type":"transform","config":{"mapping":{"step":"b","prev":"{{context.a.output.step}}"}}},
	{"id":"c","type":"transform","config":{"mapping":{"step":"c","prev":"{{context.b.output.step}}"}}}
],"edges":[{"from":"a","to":"b"},{"from":"b","to":"c"}]}`

// The claim reads input_json once; completion, downstream scheduling and
// the post-commit hooks used to read and re-parse it two to three more
// times per node. They now ride the claim snapshot: one snapshot transfer
// per claimed node, no replay-mode round trips, one context load per
// dispatch, and the rollout recorder runs only for the terminal completion.
func TestNodeCycleTransfersTheRunSnapshotOnce(t *testing.T) {
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set; run through `make test`")
	}
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	counter := &queryCounter{}
	cfg.ConnConfig.Tracer = counter
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	raw := make([]byte, 6)
	_, _ = rand.Read(raw)
	org := "org-snapshot-" + hex.EncodeToString(raw)
	eng := New(pool)

	counter.reset()
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, chainDoc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	// Start writes the node rows and the initial events in one COPY each
	// instead of one statement per node and per root.
	if copies, single := counter.get("copy:run_nodes"), counter.get("InsertRunNode"); copies != 1 || single != 0 {
		t.Fatalf("start must COPY its node rows once: copies=%d InsertRunNode=%d", copies, single)
	}
	if copies, single := counter.get("copy:run_events"), counter.get("InsertRunEventAt"); copies != 1 || single != 0 {
		t.Fatalf("start must COPY its initial events once: copies=%d InsertRunEventAt=%d", copies, single)
	}
	counter.reset()

	// The real dispatcher, so the context load per dispatch is counted too.
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	var claims int
	var mu sync.Mutex
	workerCtx, stopWorkers := context.WithCancel(ctx)
	defer stopWorkers()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = eng.RunWorkers(workerCtx, 2, 50*time.Millisecond, func(execCtx context.Context, claim ClaimedNode, node domain.Node, wf *domain.Workflow, input map[string]any) (any, error) {
			if claim.RunID == runID {
				mu.Lock()
				claims++
				mu.Unlock()
			}
			return dispatcher.Execute(execCtx, claim, node, wf, input)
		}, quietLogger())
	}()
	deadline := time.Now().Add(20 * time.Second)
	for {
		var status string
		_ = pool.QueryRow(ctx, "select status from runs where id=$1", runID).Scan(&status)
		if status == "succeeded" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("chain never completed")
		}
		time.Sleep(25 * time.Millisecond)
	}
	stopWorkers()
	<-done

	mu.Lock()
	executed := claims
	mu.Unlock()
	if executed != 3 {
		t.Fatalf("expected 3 executions, got %d", executed)
	}
	if got := counter.get("GetRunExecution"); got != executed {
		t.Fatalf("input_json must be transferred once per claim: %d reads for %d claims", got, executed)
	}
	if got := counter.get("GetRunReplayMode"); got != 0 {
		t.Fatalf("replay mode rides the claim snapshot; got %d round trips", got)
	}
	if got := counter.get("ListRunNodesByRun"); got != executed {
		t.Fatalf("one run-context load per dispatch: got %d for %d claims", got, executed)
	}
	if got := counter.get("GetRunForRolloutOutcome"); got != 1 {
		t.Fatalf("the rollout recorder must run only for the terminal completion: got %d", got)
	}
}
