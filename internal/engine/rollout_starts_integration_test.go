//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/store"
)

// seedRolloutPair saves v1 and v2 of one workflow (v2 latest) and returns both version ids.
func seedRolloutPair(t *testing.T, ctx context.Context, q *store.Queries, org, workflowID, v1Doc, v2Doc string) (string, string) {
	t.Helper()
	v1 := saveWorkflowVersion(t, ctx, q, org, workflowID, v1Doc)
	v2 := workflowID + "-v2"
	if err := q.InsertWorkflowVersion(ctx, store.InsertWorkflowVersionParams{
		ID: v2, OrgID: org, WorkflowID: workflowID, Version: 2, DagJson: json.RawMessage(v2Doc),
	}); err != nil {
		t.Fatalf("insert v2: %v", err)
	}
	return v1, v2
}

func startRollout(t *testing.T, ctx context.Context, eng *Engine, org, workflowID, baseline, canary string, traffic int) string {
	t.Helper()
	kind, rollout, err := eng.CreateWorkflowRollout(ctx, struct {
		OrgID, WorkflowID, BaselineVersionID, CanaryVersionID        string
		TrafficPercent, MinimumSampleSize, MinimumSuccessRatePercent int
		CreatedBy                                                    string
	}{
		OrgID: org, WorkflowID: workflowID, BaselineVersionID: baseline, CanaryVersionID: canary,
		TrafficPercent: traffic, MinimumSampleSize: 100, MinimumSuccessRatePercent: 1, CreatedBy: "tester",
	})
	if err != nil || kind != RolloutCreated {
		t.Fatalf("create rollout: %s %v", kind, err)
	}
	return rollout.ID
}

func finishRollout(t *testing.T, ctx context.Context, eng *Engine, org, workflowID, rolloutID, decision string) {
	t.Helper()
	if kind, _, err := eng.FinishWorkflowRollout(ctx, org, workflowID, rolloutID, decision, ""); err != nil || kind != RolloutFinishUpdated {
		t.Fatalf("%s rollout: %s %v", decision, kind, err)
	}
}

type tickRun struct{ tick, versionID, rolloutID, variant string }

// fireTicks fires one due tick per minute after base and reads back each run.
func fireTicks(t *testing.T, ctx context.Context, pool *pgxpool.Pool, eng *Engine, entry store.ClaimDueScheduleEntriesRow, base time.Time, from, count int) []tickRun {
	t.Helper()
	runs := make([]tickRun, 0, count)
	for i := from; i < from+count; i++ {
		due := base.Add(time.Duration(i) * time.Minute)
		tick := entry
		tick.DueAt = &due
		if !eng.fireScheduleEntry(ctx, tick, time.Now().UTC(), nil) {
			t.Fatalf("tick %d did not fire", i)
		}
		run := tickRun{tick: entry.ID + "@" + due.Format(time.RFC3339Nano)}
		if err := pool.QueryRow(ctx, `SELECT r.workflow_version_id, COALESCE(r.workflow_rollout_id, ''), COALESCE(r.workflow_rollout_variant, '')
			FROM schedule_entries s JOIN runs r ON r.id = s.last_run_id WHERE s.id = $1`, entry.ID).
			Scan(&run.versionID, &run.rolloutID, &run.variant); err != nil {
			t.Fatalf("tick %d run: %v", i, err)
		}
		// A retried tick replays its run instead of drawing a new arm.
		if eng.fireScheduleEntry(ctx, tick, time.Now().UTC(), nil) {
			t.Fatalf("tick %d fired twice", i)
		}
		runs = append(runs, run)
	}
	return runs
}

// Schedule ticks follow the rollout like every other production start: an
// active canary splits ticks by their deterministic key, a rolled-back canary
// sends every tick to the baseline and a promoted one sends every tick to the canary.
func TestScheduleTicksFollowTheWorkflowRollout(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	dropOrgRuns(t, pool, org)
	q := store.New(pool)
	workflowID := "wf-sched-rollout-" + org
	doc := func(extra string) string {
		return `{"dslVersion":"1.0","id":"` + workflowID + `","name":"scheduled","nodes":[` +
			`{"id":"tick","type":"schedule","config":{"cronExpression":"* * * * *"}},` +
			`{"id":"` + extra + `","type":"noop","config":{}}],"edges":[{"from":"tick","to":"` + extra + `"}]}`
	}
	v1, v2 := seedRolloutPair(t, ctx, q, org, workflowID, doc("baseline"), doc("canary"))
	// Saving v2 binds the schedule entry to the canary, as a real save does.
	if err := eng.SyncWorkflowSchedules(ctx, q, org, workflowID, v2, "tester", mustParse(t, doc("canary"))); err != nil {
		t.Fatalf("sync schedules: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE schedule_entries SET next_fire_at = now() - interval '1 minute' WHERE workflow_id = $1`, workflowID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE schedule_entries SET enabled = false WHERE org_id <> $1`, org); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	lease := now.Add(time.Minute)
	claimed, err := q.ClaimDueScheduleEntries(ctx, store.ClaimDueScheduleEntriesParams{Now: &now, LeaseUntil: &lease, RowLimit: 10})
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim: %v (%d rows)", err, len(claimed))
	}
	entry := claimed[0]
	base := now.Truncate(time.Minute)
	versionOf := map[string]string{"baseline": v1, "canary": v2}

	active := startRollout(t, ctx, eng, org, workflowID, v1, v2, 50)
	variants := map[string]int{}
	for _, run := range fireTicks(t, ctx, pool, eng, entry, base, 0, 20) {
		want := "baseline"
		if WorkflowRolloutBucket(active, run.tick) < 50 {
			want = "canary"
		}
		if run.rolloutID != active || run.variant != want || run.versionID != versionOf[want] {
			t.Fatalf("active tick %s: got %+v, want %s", run.tick, run, want)
		}
		variants[run.variant]++
	}
	if variants["baseline"] == 0 || variants["canary"] == 0 {
		t.Fatalf("a 50%% canary must split ticks (p≈2e-6 to fail): %+v", variants)
	}

	finishRollout(t, ctx, eng, org, workflowID, active, "rollback")
	for _, run := range fireTicks(t, ctx, pool, eng, entry, base, 20, 5) {
		if run.rolloutID != active || run.variant != "baseline" || run.versionID != v1 {
			t.Fatalf("a rolled-back canary must send ticks to the baseline: %+v", run)
		}
	}

	promoted := startRollout(t, ctx, eng, org, workflowID, v1, v2, 10)
	finishRollout(t, ctx, eng, org, workflowID, promoted, "promote")
	for _, run := range fireTicks(t, ctx, pool, eng, entry, base, 25, 5) {
		if run.rolloutID != promoted || run.variant != "canary" || run.versionID != v2 {
			t.Fatalf("a promoted canary must take every tick: %+v", run)
		}
	}
}

// An unpinned child whose deployment cannot be resolved fails the call
// instead of silently running the latest version.
func TestSubworkflowChildFailsClosedWhenItsRolloutIsUnreadable(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	q := store.New(pool)
	suffix := fmt.Sprint(time.Now().UnixNano())
	childID := "wf-rollout-child-" + suffix
	doc := func(node string) string {
		return `{"id":"` + childID + `","name":"child","dslVersion":"1.0","nodes":[{"id":"` + node + `","type":"noop","config":{}}],"edges":[]}`
	}
	v1, v2 := seedRolloutPair(t, ctx, q, org, childID, doc("one"), doc("two"))
	rollout := startRollout(t, ctx, eng, org, childID, v1, v2, 10)
	finishRollout(t, ctx, eng, org, childID, rollout, "rollback")
	// The baseline that now takes the traffic no longer parses.
	if _, err := pool.Exec(ctx, `UPDATE workflow_versions SET dag_json = '[]' WHERE id = $1`, v1); err != nil {
		t.Fatal(err)
	}

	parentDoc := `{"id":"wf-rollout-parent-` + suffix + `","name":"parent","dslVersion":"1.0",
		"nodes":[{"id":"call","type":"subworkflow","config":{"workflowId":"` + childID + `"}}],"edges":[]}`
	parentRunID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, parentDoc)})
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	runDispatcherToTerminal(t, eng, pool, parentRunID, "failed")
	var children int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM runs WHERE parent_run_id = $1`, parentRunID).Scan(&children)
	var callError string
	_ = pool.QueryRow(ctx, `SELECT COALESCE(error_json::text, '') FROM run_nodes WHERE run_id = $1 AND node_id = 'call'`, parentRunID).Scan(&callError)
	if children != 0 || !strings.Contains(callError, "rollout assignment") {
		t.Fatalf("the child must not start on the latest version: children=%d error=%s", children, callError)
	}
}
