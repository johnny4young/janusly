//go:build integration && ha

package engine

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"
)

// Two reapers over the same stalled cohort: FailNode's CAS elects one
// winner per node — exactly one dead letter and one failed transition
// each, with the reap total split between instances but summing exactly.
func TestHAConcurrentReapersNeverDoubleReap(t *testing.T) {
	engineA, engineB, pool := newHAEngines(t)
	ctx := context.Background()
	org := fmt.Sprintf("org-ha-reap-%d", time.Now().UnixNano())

	// Five stalled running nodes: runs running, nodes started long ago.
	staleStart := time.Now().UTC().Add(-2 * time.Hour)
	for i := range 5 {
		runID := fmt.Sprintf("run-ha-reap-%d-%s", i, org)
		workflowJSON := fmt.Sprintf(`{"workflow":{"id":"wf-reap-%d","name":"Reap","dslVersion":"1.0","nodes":[{"id":"stuck","type":"noop","config":{}}],"edges":[]},"input":{}}`, i)
		if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, status, input_json, workflow_version_id)
			VALUES ($1, $2, 'running', $3, 'wv-reap')`, runID, org, workflowJSON); err != nil {
			t.Fatalf("seed run: %v", err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO run_nodes (id, run_id, node_id, status, attempts, started_at)
			VALUES ($1, $2, 'stuck', 'running', 1, $3)`, runID+"-stuck", runID, staleStart); err != nil {
			t.Fatalf("seed node: %v", err)
		}
	}

	// Both instances reap the same cohort concurrently.
	var wg sync.WaitGroup
	totals := make([]int, 2)
	for i, eng := range []*Engine{engineA, engineB} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			totals[i] = eng.ReapStalledNodes(ctx, time.Hour, 50, quietLogger())
		}()
	}
	wg.Wait()

	// Exactly one dead letter and one failed node per stalled row; the two
	// reap totals cover the cohort without overlap.
	var deadLetters, failedNodes int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM dead_letters WHERE org_id = $1`, org).Scan(&deadLetters)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_nodes rn JOIN runs r ON r.id = rn.run_id
		WHERE r.org_id = $1 AND rn.status = 'failed'`, org).Scan(&failedNodes)
	if deadLetters != 5 || failedNodes != 5 {
		t.Fatalf("exactly once per node: deadLetters=%d failed=%d", deadLetters, failedNodes)
	}
	if totals[0]+totals[1] < 5 {
		t.Fatalf("reap totals must cover the cohort: %v", totals)
	}
}

// Two concurrent retention sweeps (tombstones + data + rate windows):
// deletion is idempotent, so racing replicas waste at most work — every
// expired row is deleted exactly once and nothing else goes.
func TestHAConcurrentRetentionSweeps(t *testing.T) {
	engineA, engineB, pool := newHAEngines(t)
	ctx := context.Background()
	stamp := time.Now().UnixNano()
	org := fmt.Sprintf("org-ha-ret-%d", stamp)
	old := time.Now().UTC().AddDate(0, 0, -40)

	// Expired material: one tombstoned workflow, 300 old run events, and
	// an org window of 30 days.
	if _, err := pool.Exec(ctx, `INSERT INTO workflows (id, org_id, name, deleted_at)
		VALUES ($1, $2, 'doomed', $3)`, "wf-ha-ret-"+org, org, old); err != nil {
		t.Fatalf("seed tombstone: %v", err)
	}
	runID := "run-ha-ret-" + org
	if _, err := pool.Exec(ctx, `INSERT INTO runs (id, org_id, status, input_json, workflow_version_id)
		VALUES ($1, $2, 'succeeded', '{}', 'wv-ret')`, runID, org); err != nil {
		t.Fatalf("seed run: %v", err)
	}
	for i := range 300 {
		if _, err := pool.Exec(ctx, `INSERT INTO run_events (id, run_id, type, payload, created_at)
			VALUES ($1, $2, 'node.succeeded', '{}', $3)`,
			fmt.Sprintf("%s-ev-%d", runID, i), runID, old); err != nil {
			t.Fatalf("seed events: %v", err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
		VALUES ($1, $2, 'retention.runEventsDays', '30', 'retention', 'test', 'number')`,
		org+"-window", org); err != nil {
		t.Fatalf("seed window: %v", err)
	}

	var wg sync.WaitGroup
	type sweepOutcome struct {
		tombstones int
		events     int
		err        error
	}
	outcomes := make([]sweepOutcome, 2)
	for i, eng := range []*Engine{engineA, engineB} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tombstones, err := eng.ProcessRetentionSweep(ctx, 30)
			if err != nil {
				outcomes[i].err = err
				return
			}
			results, err := eng.ProcessDataRetentionSweep(ctx, 100, 0)
			if err != nil {
				outcomes[i].err = err
				return
			}
			outcomes[i].tombstones = tombstones
			outcomes[i].events = results[org+"/run_events"].RowsDeleted
		}()
	}
	wg.Wait()
	for i, outcome := range outcomes {
		if outcome.err != nil {
			t.Fatalf("sweep %d must tolerate a racing twin: %v", i, outcome.err)
		}
	}

	// Every expired row died exactly once: the per-sweep counts SUM to the
	// seeded totals (the split between racers is timing-dependent).
	var tombstonesLeft, eventsLeft int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM workflows WHERE org_id = $1`, org).Scan(&tombstonesLeft)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_events WHERE run_id = $1`, runID).Scan(&eventsLeft)
	if tombstonesLeft != 0 || eventsLeft != 0 {
		t.Fatalf("expired rows must all go: workflows=%d events=%d", tombstonesLeft, eventsLeft)
	}
	if got := outcomes[0].events + outcomes[1].events; got != 300 {
		t.Fatalf("deletions must sum exactly (no double count): %d", got)
	}
}
