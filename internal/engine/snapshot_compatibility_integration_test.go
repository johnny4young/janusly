//go:build integration

package engine

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/grammar"
)

// These fixtures exercise the current runtime's rejection boundary, not
// compatibility with a previous executable or database schema generation.
func TestUnsupportedSnapshotVersionFailsBeforeExecution(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, linearDoc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE runs
		SET input_json = jsonb_set(input_json, '{workflow,dslVersion}', '"unsupported"')
		WHERE id=$1`, runID); err != nil {
		t.Fatalf("seed unsupported snapshot: %v", err)
	}
	// Own only this run's root instead of claiming another test's queued work.
	claim := ClaimedNode{RunID: runID, NodeID: "first", OrgID: org}
	if err := pool.QueryRow(ctx, `UPDATE run_nodes SET status='running', started_at=now()
		WHERE run_id=$1 AND node_id='first' AND status='queued'
		RETURNING id, attempts`, runID).Scan(&claim.RowID, &claim.Attempt); err != nil {
		t.Fatalf("claim root: %v", err)
	}
	executed := 0
	execute := func(context.Context, ClaimedNode, domain.Node, *domain.Workflow, map[string]any) (any, error) {
		executed++
		return map[string]any{"shouldNotExecute": true}, nil
	}
	reloaded := New(pool)
	reloaded.executeClaim(ctx, claim, execute, quietLogger())
	// Redelivery of the stale claim must not duplicate the durable failure.
	reloaded.executeClaim(ctx, claim, execute, quietLogger())
	if executed != 0 {
		t.Fatalf("unsupported snapshot invoked the executor %d times", executed)
	}
	var runStatus, rootStatus, afterStatus, message string
	var afterAttempts, deadLetters, failureEvents, wakeups int
	if err := pool.QueryRow(ctx, `SELECT r.status, root.status, after_node.status,
		after_node.attempts, root.error_json->>'message',
		(SELECT count(*) FROM dead_letters WHERE run_id=r.id),
		(SELECT count(*) FROM run_events WHERE run_id=r.id AND type='node.failed'),
		(SELECT count(*) FROM run_wakeups w JOIN run_nodes n ON n.id=w.run_node_id WHERE n.run_id=r.id)
		FROM runs r
		JOIN run_nodes root ON root.run_id=r.id AND root.node_id='first'
		JOIN run_nodes after_node ON after_node.run_id=r.id AND after_node.node_id='second'
		WHERE r.id=$1`, runID).Scan(&runStatus, &rootStatus, &afterStatus, &afterAttempts,
		&message, &deadLetters, &failureEvents, &wakeups); err != nil {
		t.Fatalf("read rejected claim: %v", err)
	}
	if runStatus != "failed" || rootStatus != "failed" || afterStatus != "pending" || afterAttempts != 0 {
		t.Fatalf("unsupported snapshot advanced: run=%s root=%s successor=%s attempts=%d",
			runStatus, rootStatus, afterStatus, afterAttempts)
	}
	if !strings.Contains(message, "run workflow snapshot invalid") || !strings.Contains(message, "dslVersion") {
		t.Fatalf("failure must explain the unsupported snapshot version: %q", message)
	}
	if deadLetters != 1 || failureEvents != 1 || wakeups != 0 {
		t.Fatalf("rejection must persist once without retry: dead letters=%d failures=%d wakeups=%d",
			deadLetters, failureEvents, wakeups)
	}
}

func TestIncompatibleSnapshotRejectsApprovalWithoutMutation(t *testing.T) {
	for _, test := range []struct {
		name         string
		field        []string
		errorExcerpt string
	}{
		{name: "unsupported DSL version", field: []string{"workflow", "dslVersion"}, errorExcerpt: "dslVersion"},
		{name: "unknown waiting node type", field: []string{"workflow", "nodes", "0", "type"}, errorExcerpt: "unsupported"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, pool, eng, org := newHarness(t)
			doc := `{"nodes":[
		{"id":"gate","type":"approval","config":{"until":"2099-01-01T00:00:00Z","onTimeout":"fail"}},
		{"id":"after","type":"noop","config":{}}
	],"edges":[{"from":"gate","to":"after"}]}`
			runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
			if err != nil {
				t.Fatalf("start: %v", err)
			}
			claim := ClaimedNode{RunID: runID, NodeID: "gate", OrgID: org}
			if err := pool.QueryRow(ctx, `UPDATE run_nodes SET status='running', started_at=now()
		WHERE run_id=$1 AND node_id='gate' AND status='queued'
		RETURNING id, attempts`, runID).Scan(&claim.RowID, &claim.Attempt); err != nil {
				t.Fatalf("claim approval: %v", err)
			}
			eng.executeClaim(ctx, claim, eng.NewDispatcher(grammar.RenderOptions{}).Execute, quietLogger())
			var gateStatus string
			var wakeups int
			if err := pool.QueryRow(ctx, `SELECT status,
		(SELECT count(*) FROM run_wakeups WHERE run_node_id=n.id)
		FROM run_nodes n WHERE run_id=$1 AND node_id='gate'`, runID).Scan(&gateStatus, &wakeups); err != nil {
				t.Fatalf("read waiting approval: %v", err)
			}
			if gateStatus != "waiting" || wakeups != 1 {
				t.Fatalf("fixture must own a persisted approval and deadline: status=%s wakeups=%d", gateStatus, wakeups)
			}
			if _, err := pool.Exec(ctx, `UPDATE runs
		SET input_json = jsonb_set(input_json, $2::text[], '"unsupported"')
		WHERE id=$1`, runID, test.field); err != nil {
				t.Fatalf("seed incompatible snapshot: %v", err)
			}
			readEvidence := func() []byte {
				t.Helper()
				var evidence []byte
				if err := pool.QueryRow(ctx, `SELECT jsonb_build_object(
			'run', to_jsonb(r),
			'nodes', (SELECT jsonb_agg(to_jsonb(n) ORDER BY n.id) FROM run_nodes n WHERE n.run_id=r.id),
			'events', (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM run_events e WHERE e.run_id=r.id),
			'wakeups', (SELECT jsonb_agg(to_jsonb(w) ORDER BY w.run_node_id)
				FROM run_wakeups w JOIN run_nodes n ON n.id=w.run_node_id WHERE n.run_id=r.id),
			'deadLetters', (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM dead_letters d WHERE d.run_id=r.id)
		) FROM runs r WHERE r.id=$1`, runID).Scan(&evidence); err != nil {
					t.Fatalf("read approval evidence: %v", err)
				}
				return evidence
			}
			before := readEvidence()
			err = New(pool).ResumeRun(ctx, runID, "gate")
			if err == nil || !strings.Contains(err.Error(), test.errorExcerpt) {
				t.Errorf("resume must reject the incompatible snapshot with %q, got %v", test.errorExcerpt, err)
			}
			if after := readEvidence(); !bytes.Equal(before, after) {
				t.Errorf("rejected approval mutated durable state or evidence:\nbefore: %s\nafter: %s", before, after)
			}
		})
	}
}
