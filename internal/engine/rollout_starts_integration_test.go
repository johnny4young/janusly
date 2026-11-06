//go:build integration

package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
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

func scheduledDoc(workflowID, extra string) string {
	return `{"dslVersion":"1.0","id":"` + workflowID + `","name":"scheduled","nodes":[` +
		`{"id":"tick","type":"schedule","config":{"cronExpression":"* * * * *"}},` +
		`{"id":"` + extra + `","type":"noop","config":{}}],"edges":[{"from":"tick","to":"` + extra + `"}]}`
}

// seedScheduledRollout saves a scheduled v1/v2 pair whose entry is bound to v2, as a save binds it.
func seedScheduledRollout(t *testing.T, ctx context.Context, pool *pgxpool.Pool, eng *Engine, org, workflowID string) (string, string) {
	t.Helper()
	q := store.New(pool)
	v1, v2 := seedRolloutPair(t, ctx, q, org, workflowID, scheduledDoc(workflowID, "baseline"), scheduledDoc(workflowID, "canary"))
	if err := eng.SyncWorkflowSchedules(ctx, q, org, workflowID, v2, "tester", mustParse(t, scheduledDoc(workflowID, "canary"))); err != nil {
		t.Fatalf("sync schedules: %v", err)
	}
	isolateSchedules(t, ctx, pool, org)
	return v1, v2
}

// isolateSchedules pauses other orgs' entries so a sweep claims only this org's, and restores them.
func isolateSchedules(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org string) {
	t.Helper()
	rows, err := pool.Query(ctx, `UPDATE schedule_entries SET enabled = false WHERE org_id <> $1 AND enabled RETURNING id`, org)
	if err != nil {
		t.Fatal(err)
	}
	var paused []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		paused = append(paused, id)
	}
	rows.Close()
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `UPDATE schedule_entries SET enabled = true WHERE id = ANY($1)`, paused); err != nil {
			t.Logf("restore schedule entries: %v", err)
		}
	})
}

// claimTick makes the org's entry due and claims it from the database like a sweep.
func claimTick(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org string) store.ClaimDueScheduleEntriesRow {
	t.Helper()
	if _, err := pool.Exec(ctx, `UPDATE schedule_entries SET next_fire_at = least(next_fire_at, now() - interval '1 second') WHERE org_id = $1`, org); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	lease := now.Add(time.Minute)
	claimed, err := store.New(pool).ClaimDueScheduleEntries(ctx, store.ClaimDueScheduleEntriesParams{Now: &now, LeaseUntil: &lease, RowLimit: 10})
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim: %v (%d rows)", err, len(claimed))
	}
	return claimed[0]
}

type tickRun struct{ tick, versionID, rolloutID, variant string }

func lastTickRun(t *testing.T, ctx context.Context, pool *pgxpool.Pool, entryID string) tickRun {
	t.Helper()
	var run tickRun
	if err := pool.QueryRow(ctx, `SELECT r.workflow_version_id, COALESCE(r.workflow_rollout_id, ''), COALESCE(r.workflow_rollout_variant, '')
		FROM schedule_entries s JOIN runs r ON r.id = s.last_run_id WHERE s.id = $1`, entryID).
		Scan(&run.versionID, &run.rolloutID, &run.variant); err != nil {
		t.Fatalf("tick run: %v", err)
	}
	return run
}

// fireTicks fires one due tick per minute after base and reads back each run.
func fireTicks(t *testing.T, ctx context.Context, pool *pgxpool.Pool, eng *Engine, entry store.ClaimDueScheduleEntriesRow, base time.Time, from, count int) []tickRun {
	t.Helper()
	runs := make([]tickRun, 0, count)
	for i := from; i < from+count; i++ {
		due := base.Add(time.Duration(i) * time.Minute)
		tick := entry
		tick.DueAt, tick.ClaimedDueAt = &due, &due
		if _, err := pool.Exec(ctx, `UPDATE schedule_entries SET claimed_due_at = $2 WHERE id = $1`, entry.ID, due); err != nil {
			t.Fatal(err)
		}
		if fired, err := eng.fireScheduleEntry(ctx, tick, time.Now().UTC(), nil); !fired || err != nil {
			t.Fatalf("tick %d did not fire: %v", i, err)
		}
		run := lastTickRun(t, ctx, pool, entry.ID)
		run.tick = entry.ID + "@" + due.Format(time.RFC3339Nano)
		// A retried tick replays its run instead of drawing a new arm.
		if fired, err := eng.fireScheduleEntry(ctx, tick, time.Now().UTC(), nil); fired || err != nil {
			t.Fatalf("tick %d fired twice: %v", i, err)
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
	workflowID := "wf-sched-rollout-" + org
	v1, v2 := seedScheduledRollout(t, ctx, pool, eng, org, workflowID)
	entry := claimTick(t, ctx, pool, org)
	base := time.Now().UTC().Truncate(time.Minute)
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

func countRuns(t *testing.T, ctx context.Context, pool *pgxpool.Pool, workflowID string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM runs r JOIN workflow_versions v ON v.id = r.workflow_version_id
		WHERE v.workflow_id = $1`, workflowID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// A tick re-claimed from the database after a crash between the run insert
// and the advance keeps its due time, so it replays its run on the same arm.
func TestScheduleTickReclaimedAfterALostAdvanceKeepsItsRunAndArm(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	dropOrgRuns(t, pool, org)
	workflowID := "wf-sched-crash-" + org
	v1, v2 := seedScheduledRollout(t, ctx, pool, eng, org, workflowID)
	startRollout(t, ctx, eng, org, workflowID, v1, v2, 50)

	first := claimTick(t, ctx, pool, org)
	if fired, err := eng.fireScheduleEntry(ctx, first, time.Now().UTC(), nil); !fired || err != nil {
		t.Fatalf("first attempt must fire: %v", err)
	}
	arm := lastTickRun(t, ctx, pool, first.ID)
	// Put the entry back where a crash right after StartRun leaves it: claimed, lease expired, not advanced.
	if _, err := pool.Exec(ctx, `UPDATE schedule_entries SET next_fire_at = now() - interval '1 second',
		claimed_due_at = $2, last_run_id = NULL WHERE id = $1`, first.ID, first.DueAt); err != nil {
		t.Fatal(err)
	}
	again := claimTick(t, ctx, pool, org)
	if again.DueAt == nil || !again.DueAt.Equal(*first.DueAt) {
		t.Fatalf("a re-claimed tick must keep its due time: %v != %v", again.DueAt, first.DueAt)
	}
	if fired, err := eng.fireScheduleEntry(ctx, again, time.Now().UTC(), nil); fired || err != nil {
		t.Fatalf("the re-claimed tick must replay: fired=%v %v", fired, err)
	}
	if runs := countRuns(t, ctx, pool, workflowID); runs != 1 {
		t.Fatalf("want exactly one run, got %d", runs)
	}
	if replayed := lastTickRun(t, ctx, pool, first.ID); replayed != arm {
		t.Fatalf("the replay must keep the original arm: %+v != %+v", replayed, arm)
	}
}

// A second replica that re-claims a tick whose lease ran out during a slow
// fire gets the same due time, so only one of the two fires.
func TestScheduleTickReclaimedDuringASlowFireFiresOnce(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	dropOrgRuns(t, pool, org)
	workflowID := "wf-sched-slow-" + org
	v1, v2 := seedScheduledRollout(t, ctx, pool, eng, org, workflowID)
	startRollout(t, ctx, eng, org, workflowID, v1, v2, 50)

	slow := claimTick(t, ctx, pool, org)
	if _, err := pool.Exec(ctx, `UPDATE schedule_entries SET next_fire_at = now() - interval '1 second' WHERE id = $1`, slow.ID); err != nil {
		t.Fatal(err)
	}
	other := claimTick(t, ctx, pool, org)
	if fired, err := eng.fireScheduleEntry(ctx, other, time.Now().UTC(), nil); !fired || err != nil {
		t.Fatalf("the second replica must fire: %v", err)
	}
	if fired, err := eng.fireScheduleEntry(ctx, slow, time.Now().UTC(), nil); fired || err != nil {
		t.Fatalf("the slow replica must replay: fired=%v %v", fired, err)
	}
	if runs := countRuns(t, ctx, pool, workflowID); runs != 1 {
		t.Fatalf("want exactly one run, got %d", runs)
	}
}

// A failed clock advance after the run started is reported, and the next
// claim replays that run instead of starting another.
func TestScheduleTickReportsAFailedAdvanceAndReplaysIt(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	dropOrgRuns(t, pool, org)
	workflowID := "wf-sched-advance-" + org
	seedScheduledRollout(t, ctx, pool, eng, org, workflowID)
	entry := claimTick(t, ctx, pool, org)
	function := "fail_advance_" + strings.ReplaceAll(strings.ReplaceAll(org, "-", "_"), ".", "_")
	for _, statement := range []string{
		`CREATE FUNCTION ` + function + `() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'advance refused'; END $$`,
		`CREATE TRIGGER ` + function + ` BEFORE UPDATE OF last_run_at ON schedule_entries FOR EACH ROW WHEN (NEW.id = '` + entry.ID + `') EXECUTE FUNCTION ` + function + `()`,
	} {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	dropTrigger := func() {
		_, _ = pool.Exec(context.Background(), `DROP TRIGGER IF EXISTS `+function+` ON schedule_entries`)
		_, _ = pool.Exec(context.Background(), `DROP FUNCTION IF EXISTS `+function+`()`)
	}
	t.Cleanup(dropTrigger)
	if fired, err := eng.fireScheduleEntry(ctx, entry, time.Now().UTC(), nil); err == nil || !strings.Contains(err.Error(), "advance") {
		t.Fatalf("a failed advance must be reported: fired=%v err=%v", fired, err)
	}
	dropTrigger()
	again := claimTick(t, ctx, pool, org)
	if fired, err := eng.fireScheduleEntry(ctx, again, time.Now().UTC(), nil); fired || err != nil {
		t.Fatalf("the next claim must replay the started run: fired=%v %v", fired, err)
	}
	if runs := countRuns(t, ctx, pool, workflowID); runs != 1 {
		t.Fatalf("want exactly one run, got %d", runs)
	}
}

// A rollout whose assigned version cannot run drops the tick with an audit
// row and moves to the next cron occurrence instead of stalling the schedule.
func TestScheduleTickDroppedWhenItsRolloutCannotRun(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	dropOrgRuns(t, pool, org)
	workflowID := "wf-sched-broken-" + org
	v1, v2 := seedScheduledRollout(t, ctx, pool, eng, org, workflowID)
	rollout := startRollout(t, ctx, eng, org, workflowID, v1, v2, 10)
	finishRollout(t, ctx, eng, org, workflowID, rollout, "rollback")
	if _, err := pool.Exec(ctx, `UPDATE workflow_versions SET dag_json = '[]' WHERE id = $1`, v1); err != nil {
		t.Fatal(err)
	}

	entry := claimTick(t, ctx, pool, org)
	now := time.Now().UTC()
	if fired, err := eng.fireScheduleEntry(ctx, entry, now, nil); fired || err != nil {
		t.Fatalf("the tick must be dropped, not retried: fired=%v %v", fired, err)
	}
	var reason, versionID string
	if err := pool.QueryRow(ctx, `SELECT metadata->>'reason', metadata->>'versionId' FROM audit_logs
		WHERE org_id = $1 AND action = 'schedule.tick.dropped' AND target_id = $2`, org, rollout).Scan(&reason, &versionID); err != nil {
		t.Fatalf("drop audit: %v", err)
	}
	if reason != "rollout_version_unavailable" || versionID != v1 {
		t.Fatalf("drop audit: %s %s", reason, versionID)
	}
	var next time.Time
	var claimed *time.Time
	_ = pool.QueryRow(ctx, `SELECT next_fire_at, claimed_due_at FROM schedule_entries WHERE id = $1`, entry.ID).Scan(&next, &claimed)
	if want := now.Truncate(time.Minute).Add(time.Minute); !next.Equal(want) || claimed != nil {
		t.Fatalf("the entry must advance to the next cron occurrence: %v (want %v), claimed %v", next, want, claimed)
	}

	if _, err := pool.Exec(ctx, `UPDATE workflow_versions SET dag_json = $2 WHERE id = $1`, v1, scheduledDoc(workflowID, "baseline")); err != nil {
		t.Fatal(err)
	}
	nextTick := claimTick(t, ctx, pool, org)
	if fired, err := eng.fireScheduleEntry(ctx, nextTick, time.Now().UTC(), nil); !fired || err != nil {
		t.Fatalf("the next occurrence must fire: %v", err)
	}
	if run := lastTickRun(t, ctx, pool, entry.ID); run.versionID != v1 || run.variant != "baseline" {
		t.Fatalf("the next occurrence runs the baseline: %+v", run)
	}
}

// A read failure is not a drop: the tick keeps its claim for a retry.
func TestScheduleTickRetriesATransientFailure(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	dropOrgRuns(t, pool, org)
	workflowID := "wf-sched-retry-" + org
	seedScheduledRollout(t, ctx, pool, eng, org, workflowID)
	entry := claimTick(t, ctx, pool, org)
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if fired, err := eng.fireScheduleEntry(cancelled, entry, time.Now().UTC(), nil); fired || err == nil {
		t.Fatalf("a failed read must be reported for retry: fired=%v err=%v", fired, err)
	}
	var claimed *time.Time
	_ = pool.QueryRow(ctx, `SELECT claimed_due_at FROM schedule_entries WHERE id = $1`, entry.ID).Scan(&claimed)
	if claimed == nil || !claimed.Equal(*entry.DueAt) {
		t.Fatalf("the tick must keep its claim: %v", claimed)
	}
}

// A sweep under a rollout reads no version list and parses each needed version once.
func TestScheduleSweepUnderARolloutLoadsOnlyTheAssignedVersions(t *testing.T) {
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
	org := fmt.Sprintf("org-sched-cost-%d", time.Now().UnixNano())
	eng := New(pool)
	dropOrgRuns(t, pool, org)
	q := store.New(pool)
	workflowID := "wf-sched-cost-" + org
	const ticks = 8
	nodes := make([]string, 0, ticks)
	for i := range ticks {
		nodes = append(nodes, fmt.Sprintf(`{"id":"s%d","type":"schedule","config":{"cronExpression":"* * * * *"}}`, i))
	}
	doc := `{"dslVersion":"1.0","id":"` + workflowID + `","name":"scheduled","nodes":[` + strings.Join(nodes, ",") + `],"edges":[]}`
	baseline := saveWorkflowVersion(t, ctx, q, org, workflowID, doc)
	latest := baseline
	for version := int32(2); version <= 40; version++ {
		latest = fmt.Sprintf("%s-v%d", workflowID, version)
		if err := q.InsertWorkflowVersion(ctx, store.InsertWorkflowVersionParams{
			ID: latest, OrgID: org, WorkflowID: workflowID, Version: version, DagJson: json.RawMessage(doc),
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := eng.SyncWorkflowSchedules(ctx, q, org, workflowID, latest, "tester", mustParse(t, doc)); err != nil {
		t.Fatal(err)
	}
	startRollout(t, ctx, eng, org, workflowID, baseline, latest, 50)
	if _, err := pool.Exec(ctx, `UPDATE schedule_entries SET next_fire_at = now() - interval '1 minute' WHERE workflow_id = $1`, workflowID); err != nil {
		t.Fatal(err)
	}
	isolateSchedules(t, ctx, pool, org)

	counter.reset()
	fired, _, err := eng.SweepDueSchedules(ctx)
	if err != nil || fired != ticks {
		t.Fatalf("sweep: fired %d of %d: %v", fired, ticks, err)
	}
	if lists := counter.get("ListWorkflowVersionsForRollout"); lists != 0 {
		t.Fatalf("ticks must not list the version history, got %d reads", lists)
	}
	if reads := counter.get("GetWorkflowVersionByID"); reads > 2 {
		t.Fatalf("a sweep parses at most the canary and the baseline, got %d document reads", reads)
	}
}

// An unpinned child whose deployment cannot be resolved fails the call
// instead of silently running the latest version, and names what to fix.
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
	if children != 0 || !strings.Contains(callError, rollout) || !strings.Contains(callError, v1) {
		t.Fatalf("the child must not start, and the error must name the rollout and version: children=%d error=%s", children, callError)
	}
}

// A rollout-routed child records the version number it was assigned.
func TestSubworkflowChildRecordsItsAssignedVersion(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	q := store.New(pool)
	suffix := fmt.Sprint(time.Now().UnixNano())
	childID := "wf-rollout-child-v-" + suffix
	doc := func(node string) string {
		return `{"id":"` + childID + `","name":"child","dslVersion":"1.0","nodes":[{"id":"` + node + `","type":"noop","config":{}}],"edges":[]}`
	}
	v1, v2 := seedRolloutPair(t, ctx, q, org, childID, doc("one"), doc("two"))
	finishRollout(t, ctx, eng, org, childID, startRollout(t, ctx, eng, org, childID, v1, v2, 10), "promote")

	parentDoc := `{"id":"wf-rollout-parent-v-` + suffix + `","name":"parent","dslVersion":"1.0",
		"nodes":[{"id":"call","type":"subworkflow","config":{"workflowId":"` + childID + `"}}],"edges":[]}`
	parentRunID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, parentDoc)})
	if err != nil {
		t.Fatalf("start parent: %v", err)
	}
	runDispatcherToTerminal(t, eng, pool, parentRunID, "succeeded")
	var version string
	_ = pool.QueryRow(ctx, `SELECT payload->>'childWorkflowVersion' FROM run_events
		WHERE run_id = $1 AND type = 'subworkflow.started'`, parentRunID).Scan(&version)
	if version != "2" {
		t.Fatalf("the routed child must record v2, got %q", version)
	}
}

func droppedTicks(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org, reason string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_logs WHERE org_id = $1 AND action = 'schedule.tick.dropped'
		AND metadata->>'reason' = $2`, org, reason).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// Rollout creation requires identical trigger contracts, so this cannot
// happen through the API; the tick still refuses an arm without its trigger.
func TestScheduleTickDroppedWhenTheAssignedArmLacksItsTrigger(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	dropOrgRuns(t, pool, org)
	workflowID := "wf-sched-trigger-" + org
	v1, v2 := seedScheduledRollout(t, ctx, pool, eng, org, workflowID)
	finishRollout(t, ctx, eng, org, workflowID, startRollout(t, ctx, eng, org, workflowID, v1, v2, 10), "rollback")
	if _, err := pool.Exec(ctx, `UPDATE workflow_versions SET dag_json = $2 WHERE id = $1`, v1,
		`{"dslVersion":"1.0","id":"`+workflowID+`","name":"scheduled","nodes":[{"id":"baseline","type":"noop","config":{}}],"edges":[]}`); err != nil {
		t.Fatal(err)
	}
	entry := claimTick(t, ctx, pool, org)
	if fired, err := eng.fireScheduleEntry(ctx, entry, time.Now().UTC(), nil); fired || err != nil {
		t.Fatalf("an arm without the trigger must not run: fired=%v %v", fired, err)
	}
	if runs := countRuns(t, ctx, pool, workflowID); runs != 0 || droppedTicks(t, ctx, pool, org, "rollout_trigger_missing") != 1 {
		t.Fatalf("want a dropped tick and no run, got %d runs", runs)
	}
}

// A holder whose claim was superseded neither clears the newer claim nor audits.
func TestScheduleTickStaleHolderLeavesTheNewerClaim(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	dropOrgRuns(t, pool, org)
	workflowID := "wf-sched-stale-" + org
	seedScheduledRollout(t, ctx, pool, eng, org, workflowID)
	stale := claimTick(t, ctx, pool, org)
	newer := stale.DueAt.Add(time.Hour)
	if _, err := pool.Exec(ctx, `UPDATE schedule_entries SET claimed_due_at = $2 WHERE id = $1`, stale.ID, newer); err != nil {
		t.Fatal(err)
	}
	if _, err := eng.fireScheduleEntry(ctx, stale, time.Now().UTC(), nil); err != nil {
		t.Fatal(err)
	}
	var claimed *time.Time
	_ = pool.QueryRow(ctx, `SELECT claimed_due_at FROM schedule_entries WHERE id = $1`, stale.ID).Scan(&claimed)
	if claimed == nil || !claimed.Equal(newer) {
		t.Fatalf("a stale holder must not clear the newer claim: %v", claimed)
	}
}

// A retried tick whose run already started is recorded, even when its rollout
// arm can no longer be loaded.
func TestScheduleTickWithAStartedRunIsNeverDropped(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	dropOrgRuns(t, pool, org)
	workflowID := "wf-sched-replay-" + org
	v1, v2 := seedScheduledRollout(t, ctx, pool, eng, org, workflowID)
	rollout := startRollout(t, ctx, eng, org, workflowID, v1, v2, 50)
	first := claimTick(t, ctx, pool, org)
	if fired, err := eng.fireScheduleEntry(ctx, first, time.Now().UTC(), nil); !fired || err != nil {
		t.Fatalf("first attempt must fire: %v", err)
	}
	var runID string
	_ = pool.QueryRow(ctx, `SELECT last_run_id FROM schedule_entries WHERE id = $1`, first.ID).Scan(&runID)
	finishRollout(t, ctx, eng, org, workflowID, rollout, "rollback")
	if _, err := pool.Exec(ctx, `UPDATE workflow_versions SET dag_json = '[]' WHERE id = $1`, v1); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE schedule_entries SET next_fire_at = now() - interval '1 second',
		claimed_due_at = $2, last_run_id = NULL WHERE id = $1`, first.ID, first.DueAt); err != nil {
		t.Fatal(err)
	}
	again := claimTick(t, ctx, pool, org)
	if fired, err := eng.fireScheduleEntry(ctx, again, time.Now().UTC(), nil); fired || err != nil {
		t.Fatalf("the retried tick must replay: fired=%v %v", fired, err)
	}
	var recorded string
	_ = pool.QueryRow(ctx, `SELECT COALESCE(last_run_id, '') FROM schedule_entries WHERE id = $1`, first.ID).Scan(&recorded)
	if recorded != runID || droppedTicks(t, ctx, pool, org, "rollout_version_unavailable") != 0 {
		t.Fatalf("the started run must be recorded, not dropped: %q != %q", recorded, runID)
	}
}

// Two holders of one undeliverable tick audit its drop once.
func TestScheduleTickDropIsAuditedOnce(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	dropOrgRuns(t, pool, org)
	workflowID := "wf-sched-once-" + org
	v1, v2 := seedScheduledRollout(t, ctx, pool, eng, org, workflowID)
	finishRollout(t, ctx, eng, org, workflowID, startRollout(t, ctx, eng, org, workflowID, v1, v2, 10), "rollback")
	if _, err := pool.Exec(ctx, `UPDATE workflow_versions SET dag_json = '[]' WHERE id = $1`, v1); err != nil {
		t.Fatal(err)
	}
	slow := claimTick(t, ctx, pool, org)
	if _, err := pool.Exec(ctx, `UPDATE schedule_entries SET next_fire_at = now() - interval '1 second' WHERE id = $1`, slow.ID); err != nil {
		t.Fatal(err)
	}
	other := claimTick(t, ctx, pool, org)
	for _, holder := range []store.ClaimDueScheduleEntriesRow{other, slow} {
		if _, err := eng.fireScheduleEntry(ctx, holder, time.Now().UTC(), nil); err != nil {
			t.Fatal(err)
		}
	}
	if drops := droppedTicks(t, ctx, pool, org, "rollout_version_unavailable"); drops != 1 {
		t.Fatalf("want one drop audit for one tick, got %d", drops)
	}
}

// An entry version that no longer parses drops the tick with an audit row.
func TestScheduleTickOnAnUnparseableVersionIsAudited(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	dropOrgRuns(t, pool, org)
	workflowID := "wf-sched-unparse-" + org
	_, v2 := seedScheduledRollout(t, ctx, pool, eng, org, workflowID)
	if _, err := pool.Exec(ctx, `UPDATE workflow_versions SET dag_json = '[]' WHERE id = $1`, v2); err != nil {
		t.Fatal(err)
	}
	entry := claimTick(t, ctx, pool, org)
	if fired, err := eng.fireScheduleEntry(ctx, entry, time.Now().UTC(), nil); fired || err != nil {
		t.Fatalf("fired=%v %v", fired, err)
	}
	var claimed *time.Time
	_ = pool.QueryRow(ctx, `SELECT claimed_due_at FROM schedule_entries WHERE id = $1`, entry.ID).Scan(&claimed)
	if droppedTicks(t, ctx, pool, org, "version_unparseable") != 1 || claimed != nil {
		t.Fatalf("want an audited drop and an advanced entry, claimed %v", claimed)
	}
}
