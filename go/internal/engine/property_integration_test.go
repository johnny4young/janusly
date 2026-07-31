//go:build integration

package engine

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/grammar"
)

// Property harness: random forward-only DAGs (guaranteed acyclic) run under
// a real worker pool, then every queue invariant is checked from the
// database — not from the API projection:
//
//   exactly-once  every node succeeded with attempts == 1 and exactly one
//                 node.succeeded event; no duplicate deliveries survive the
//                 claim ladder.
//   ordering      a node's success is never stamped before any of its
//                 predecessors' (event timestamps, ms precision, >=).
//   no-orphan     nothing remains pending/queued/running after terminal.
//   terminal      exactly one run.started and one run.succeeded event.
//
// Seeds are fixed for reproducibility; a failure names its seed.
func TestQueuePropertiesOverRandomDAGs(t *testing.T) {
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()

	eng := New(pool)
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() { _ = eng.RunWorkers(workerCtx, 6, 20*time.Millisecond, dispatcher.Execute, quietLogger()) }()

	org := fmt.Sprintf("org-props-%d", time.Now().UnixNano())
	for seed := range 25 {
		rng := rand.New(rand.NewPCG(uint64(seed), 42))
		wf := randomForwardDAG(rng, seed)
		runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
		if err != nil {
			t.Fatalf("seed %d: start: %v", seed, err)
		}
		waitRunStatus(t, pool, runID, "succeeded", seed)
		assertQueueInvariants(t, pool, runID, wf, seed)
	}
}

// randomForwardDAG builds 3..12 nodes with edges only from lower to higher
// index — acyclic by construction — mixing noop and transform nodes.
func randomForwardDAG(rng *rand.Rand, seed int) *domain.Workflow {
	nodeCount := 3 + rng.IntN(10)
	nodes := make([]domain.Node, 0, nodeCount)
	for i := range nodeCount {
		id := fmt.Sprintf("n%02d", i)
		if rng.IntN(2) == 0 {
			nodes = append(nodes, domain.Node{ID: id, Type: "noop", Config: map[string]any{}})
		} else {
			nodes = append(nodes, domain.Node{ID: id, Type: "transform",
				Config: map[string]any{"mapping": map[string]any{"self": id, "seed": fmt.Sprint(seed)}}})
		}
	}
	var edges []domain.Edge
	for to := 1; to < nodeCount; to++ {
		// Each node gets 1..2 predecessors from the earlier prefix, so the
		// graph stays connected and fan-in shapes appear naturally.
		predecessors := 1 + rng.IntN(2)
		seen := map[int]bool{}
		for range predecessors {
			from := rng.IntN(to)
			if seen[from] {
				continue
			}
			seen[from] = true
			edges = append(edges, domain.Edge{From: fmt.Sprintf("n%02d", from), To: fmt.Sprintf("n%02d", to)})
		}
	}
	return &domain.Workflow{DSLVersion: "1.0", Nodes: nodes, Edges: edges}
}

func waitRunStatus(t *testing.T, pool *pgxpool.Pool, runID, want string, seed int) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		var status string
		if err := pool.QueryRow(context.Background(),
			`SELECT status FROM runs WHERE id = $1`, runID).Scan(&status); err == nil && status == want {
			return
		} else if status == "failed" || status == "cancelled" {
			t.Fatalf("seed %d: run reached %s", seed, status)
		}
		if time.Now().After(deadline) {
			t.Fatalf("seed %d: run never reached %s", seed, want)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func assertQueueInvariants(t *testing.T, pool *pgxpool.Pool, runID string, wf *domain.Workflow, seed int) {
	t.Helper()
	ctx := context.Background()

	// exactly-once + no-orphan over run_nodes.
	rows, err := pool.Query(ctx,
		`SELECT node_id, status, COALESCE(attempts, 0) FROM run_nodes WHERE run_id = $1`, runID)
	if err != nil {
		t.Fatalf("seed %d: nodes: %v", seed, err)
	}
	nodeStatus := map[string]string{}
	for rows.Next() {
		var nodeID, status string
		var attempts int
		if err := rows.Scan(&nodeID, &status, &attempts); err != nil {
			t.Fatalf("seed %d: scan: %v", seed, err)
		}
		nodeStatus[nodeID] = status
		if status != "succeeded" || attempts != 1 {
			t.Fatalf("seed %d: node %s status=%s attempts=%d (exactly-once broken)", seed, nodeID, status, attempts)
		}
	}
	rows.Close()
	if len(nodeStatus) != len(wf.Nodes) {
		t.Fatalf("seed %d: %d node rows for %d nodes (orphan or ghost)", seed, len(nodeStatus), len(wf.Nodes))
	}

	// Event accounting: one success per node, one started + one succeeded.
	succeededAt := map[string]time.Time{}
	eventRows, err := pool.Query(ctx,
		`SELECT type, COALESCE(node_id, ''), created_at FROM run_events WHERE run_id = $1`, runID)
	if err != nil {
		t.Fatalf("seed %d: events: %v", seed, err)
	}
	counts := map[string]int{}
	for eventRows.Next() {
		var eventType, nodeID string
		var at time.Time
		if err := eventRows.Scan(&eventType, &nodeID, &at); err != nil {
			t.Fatalf("seed %d: scan event: %v", seed, err)
		}
		counts[eventType]++
		if eventType == "node.succeeded" {
			if _, dup := succeededAt[nodeID]; dup {
				t.Fatalf("seed %d: node %s succeeded twice", seed, nodeID)
			}
			succeededAt[nodeID] = at
		}
	}
	eventRows.Close()
	if counts["run.started"] != 1 || counts["run.succeeded"] != 1 {
		t.Fatalf("seed %d: terminal events %v", seed, counts)
	}
	if len(succeededAt) != len(wf.Nodes) {
		t.Fatalf("seed %d: %d success events for %d nodes", seed, len(succeededAt), len(wf.Nodes))
	}

	// Ordering: a successor never succeeds before any predecessor.
	for _, edge := range wf.Edges {
		if succeededAt[edge.To].Before(succeededAt[edge.From]) {
			t.Fatalf("seed %d: edge %s→%s violated ordering (%s < %s)",
				seed, edge.From, edge.To, succeededAt[edge.To], succeededAt[edge.From])
		}
	}
}
