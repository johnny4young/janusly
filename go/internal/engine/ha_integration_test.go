//go:build integration && ha

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

// The HA lane: TWO engines with SEPARATE pools over ONE database — the
// closest in-test model of two API replicas. Every invariant the
// single-instance property suite enforces must hold when both instances'
// worker pools race for the same claims: exactly-once execution, ordering,
// no orphans, one terminal transition. The claim ladder (SKIP LOCKED lock
// + fresh-snapshot re-check + CAS) is the guarantee under test.
func newHAEngines(t *testing.T) (*Engine, *Engine, *pgxpool.Pool) {
	t.Helper()
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set; run through `make test-ha`")
	}
	poolA, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool A: %v", err)
	}
	t.Cleanup(poolA.Close)
	poolB, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("pool B: %v", err)
	}
	t.Cleanup(poolB.Close)

	engineA, engineB := New(poolA), New(poolB)
	for _, pair := range []struct {
		engine *Engine
		pool   *pgxpool.Pool
	}{{engineA, poolA}, {engineB, poolB}} {
		dispatcher := pair.engine.NewDispatcher(grammar.RenderOptions{})
		workerCtx, stop := context.WithCancel(context.Background())
		done := make(chan struct{})
		engineRef := pair.engine
		go func() {
			defer close(done)
			_ = engineRef.RunWorkers(workerCtx, 4, 15*time.Millisecond, dispatcher.Execute, quietLogger())
		}()
		go engineRef.RunReplayCampaignPump(workerCtx, 15*time.Millisecond, quietLogger())
		t.Cleanup(func() { stop(); <-done })
	}
	return engineA, engineB, poolA
}

// Property DAGs under two racing instances, three rounds: starts split
// across both engines, every queue invariant asserted from the database.
func TestHAPropertyDAGsAcrossTwoInstances(t *testing.T) {
	engineA, engineB, pool := newHAEngines(t)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	for round := range 3 {
		org := fmt.Sprintf("org-ha-props-%d-%d", round, time.Now().UnixNano())
		for seed := range 25 {
			rng := rand.New(rand.NewPCG(uint64(seed), uint64(round)+7))
			wf := randomForwardDAG(rng, seed)
			starter := engineA
			if seed%2 == 1 {
				starter = engineB
			}
			runID, err := starter.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
			if err != nil {
				t.Fatalf("round %d seed %d: start: %v", round, seed, err)
			}
			waitRunStatus(t, pool, runID, "succeeded", seed)
			assertQueueInvariants(t, pool, runID, wf, seed)
		}
	}
}

// One replay campaign drained by BOTH pumps: every item settles exactly
// once (the dispatch claim pushes the due clock atomically), the counters
// stay truthful, and exactly one completion lands.
func TestHACampaignNoDoubleDispatch(t *testing.T) {
	engineA, _, pool := newHAEngines(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	org := fmt.Sprintf("org-ha-camp-%d", time.Now().UnixNano())

	// Ten dead letters from failing runs started on instance A.
	for i := range 10 {
		wf := failingWorkflow(fmt.Sprintf("wf-ha-camp-%d-%s", i, org))
		runID, err := engineA.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
		if err != nil {
			t.Fatalf("start %d: %v", i, err)
		}
		waitRunStatus(t, pool, runID, "failed", i)
	}
	rows, err := pool.Query(ctx, `SELECT id FROM dead_letters WHERE org_id = $1`, org)
	if err != nil {
		t.Fatalf("dead letters: %v", err)
	}
	var ids []string
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	if len(ids) != 10 {
		t.Fatalf("want 10 dead letters, got %d", len(ids))
	}

	// The campaign at fast pacing; BOTH pumps are already polling.
	campaignID := fmt.Sprintf("camp-ha-%d", time.Now().UnixNano())
	if _, err := pool.Exec(ctx, `INSERT INTO replay_campaigns
		(id, org_id, name, cluster_signature, filter_json, pacing_ms, status, total_count, created_by, next_dispatch_at, started_at)
		VALUES ($1, $2, 'ha drain', 'sig', '{}', 40, 'running', 10, 'ha-test', now(), now())`,
		campaignID, org); err != nil {
		t.Fatalf("campaign: %v", err)
	}
	for position, id := range ids {
		if _, err := pool.Exec(ctx, `INSERT INTO replay_campaign_items
			(id, org_id, campaign_id, dead_letter_id, position)
			VALUES ($1, $2, $3, $4, $5)`,
			fmt.Sprintf("%s-item-%d", campaignID, position), org, campaignID, id, position); err != nil {
			t.Fatalf("item: %v", err)
		}
	}

	deadline := time.Now().Add(90 * time.Second)
	for {
		var status string
		var replayed, failed int
		if err := pool.QueryRow(ctx, `SELECT status, replayed_count, failed_count
			FROM replay_campaigns WHERE id = $1`, campaignID).Scan(&status, &replayed, &failed); err != nil {
			t.Fatalf("read campaign: %v", err)
		}
		if status == "completed" {
			if replayed+failed != 10 {
				t.Fatalf("counters must cover the cohort exactly: replayed=%d failed=%d", replayed, failed)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("campaign never completed: %s %d/%d", status, replayed, failed)
		}
		time.Sleep(50 * time.Millisecond)
	}

	// No double dispatch: each item settled exactly once, and each dead
	// letter's replay was claimed exactly once.
	var overSettled int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM replay_campaign_items
		WHERE campaign_id = $1 AND (attempt_count > 1 OR status NOT IN ('replayed','failed'))`,
		campaignID).Scan(&overSettled)
	if overSettled != 0 {
		t.Fatalf("items settled more than once or left dangling: %d", overSettled)
	}
	// The ORIGINAL cohort must carry exactly one replay claim each. (The
	// revived runs fail again against the still-dead target and mint NEW
	// open dead letters — the honest consequence of revive-in-place.)
	var unclaimed int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM dead_letters
		WHERE id = ANY($1::text[]) AND replay_claimed_at IS NULL`, ids).Scan(&unclaimed)
	if unclaimed != 0 {
		t.Fatalf("every cohort dead letter must carry one replay claim: %d unclaimed", unclaimed)
	}
	// Exactly one system completion audit — the CAS on status='running'
	// guarantees one winner even with two pumps racing the finish line.
	var completions int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs
		WHERE org_id = $1 AND action = 'recovery.campaign.completed'`, org).Scan(&completions)
	if completions != 1 {
		t.Fatalf("exactly one completion audit: %d", completions)
	}
}

// Mass delayed retries under two instances: forty failing-then-retrying
// nodes with real backoff wake-ups; every node executes its retries
// without a lost or double wake-up, and every run terminates.
func TestHAMassTimersAcrossTwoInstances(t *testing.T) {
	// The retry ladder needs a RETRYABLE failure: with private targets
	// allowed, 127.0.0.1:1 yields connection-refused (network class)
	// instead of the permanent SSRF-guard rejection.
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	engineA, engineB, pool := newHAEngines(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	org := fmt.Sprintf("org-ha-timer-%d", time.Now().UnixNano())

	runIDs := make([]string, 0, 40)
	for i := range 40 {
		wf := failingWorkflow(fmt.Sprintf("wf-ha-timer-%d-%s", i, org))
		// Two quick retries per node: attempts=3 with a short backoff.
		wf.Nodes[0].Config["retry"] = map[string]any{
			"maxAttempts": float64(3), "delayMs": float64(60),
		}
		starter := engineA
		if i%2 == 1 {
			starter = engineB
		}
		runID, err := starter.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
		if err != nil {
			t.Fatalf("start %d: %v", i, err)
		}
		runIDs = append(runIDs, runID)
	}
	for i, runID := range runIDs {
		waitRunStatus(t, pool, runID, "failed", i)
	}

	// Exactly-once per attempt: each node reached attempts=3 with exactly
	// two node.retry events; no wakeup rows remain.
	var wrongAttempts int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_nodes rn JOIN runs r ON r.id = rn.run_id
		WHERE r.org_id = $1 AND rn.attempts <> 3`, org).Scan(&wrongAttempts)
	if wrongAttempts != 0 {
		t.Fatalf("every node must consume exactly its retry budget: %d off", wrongAttempts)
	}
	var retryEvents int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM run_events ev JOIN runs r ON r.id = ev.run_id
		WHERE r.org_id = $1 AND ev.type = 'node.retry'`, org).Scan(&retryEvents)
	if retryEvents != 80 {
		t.Fatalf("40 nodes x 2 retries = 80 retry events, got %d", retryEvents)
	}
	var leakedWakeups int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM go_pilot_wakeups w
		JOIN run_nodes rn ON rn.id = w.run_node_id
		JOIN runs r ON r.id = rn.run_id WHERE r.org_id = $1`, org).Scan(&leakedWakeups)
	if leakedWakeups != 0 {
		t.Fatalf("wake-ups must die with their terminal nodes: %d leaked", leakedWakeups)
	}
}

// failingWorkflow builds the standard dead-target http workflow.
func failingWorkflow(id string) *domain.Workflow {
	return &domain.Workflow{
		ID: id, Name: "HA Fail", DSLVersion: "1.0",
		Nodes: []domain.Node{{ID: "call", Type: "http", Config: map[string]any{
			"url": "http://127.0.0.1:1", "timeoutMs": float64(200),
		}}},
		Edges: []domain.Edge{},
	}
}
