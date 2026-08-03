//go:build integration

package engine

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/grammar"
)

// The chokepoint acceptance property: after a run deliberately seeded with
// secret-shaped material — sensitive keys flowing through node outputs AND
// a failing node that captures workflow/node/error snapshots into the DLQ —
// no secret VALUE under a sensitive KEY survives in any chokepoint jsonb
// column (run_nodes.state_json / error_json, run_events.payload,
// dead_letters.workflow_json / node_json / error_json).
func TestSafePersistPropertyNoSecretSurvivesJsonb(t *testing.T) {
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
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
	go func() { _ = eng.RunWorkers(workerCtx, 2, 20*time.Millisecond, dispatcher.Execute, quietLogger()) }()

	const leakedKey = "sk-live-PROPERTY-LEAK"
	const leakedPassword = "hunter2-PROPERTY"

	// The transform emits secret-shaped fields into its output (state_json +
	// the node.succeeded event); the http node carries an Authorization-named
	// config field and fails against a dead target, so the DLQ captures the
	// workflow and node snapshots that contain the secrets.
	wf := &domain.Workflow{
		ID: "wf-persist-prop", Name: "Persist Property", DSLVersion: "1.0",
		Nodes: []domain.Node{
			{ID: "emit", Type: "transform", Config: map[string]any{
				"mapping": map[string]any{"apiKey": leakedKey, "note": "plain"},
			}},
			{ID: "call", Type: "http", Config: map[string]any{
				"url": "http://127.0.0.1:1", "timeoutMs": float64(200),
				"headers":  map[string]any{"authorization": "Bearer " + leakedKey, "x-trace": "keep"},
				"password": leakedPassword,
			}},
		},
		Edges: []domain.Edge{{From: "emit", To: "call"}},
	}
	org := fmt.Sprintf("org-persist-prop-%d", time.Now().UnixNano())
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	waitRunStatus(t, pool, runID, "failed", 0)

	// Sweep every chokepoint column for the secret VALUES. runs.input_json is
	// deliberately NOT in the sweep — the run input is the operator's own
	// document and replay needs it verbatim (the DLQ's key-redacted workflow
	// snapshot is the safe projection of it).
	sweeps := map[string]string{
		"run_nodes.state_json": `SELECT count(*) FROM run_nodes WHERE run_id = $1 AND state_json::text LIKE '%' || $2 || '%'`,
		"run_nodes.error_json": `SELECT count(*) FROM run_nodes WHERE run_id = $1 AND error_json::text LIKE '%' || $2 || '%'`,
		"run_events.payload":   `SELECT count(*) FROM run_events WHERE run_id = $1 AND payload::text LIKE '%' || $2 || '%'`,
		"dead_letters.*": `SELECT count(*) FROM dead_letters WHERE run_id = $1 AND
			(workflow_json::text LIKE '%' || $2 || '%' OR node_json::text LIKE '%' || $2 || '%'
			 OR error_json::text LIKE '%' || $2 || '%')`,
	}
	for _, secret := range []string{leakedKey, leakedPassword} {
		for column, sweep := range sweeps {
			var n int
			if err := pool.QueryRow(ctx, sweep, runID, secret).Scan(&n); err != nil {
				t.Fatalf("sweep %s: %v", column, err)
			}
			if n != 0 {
				t.Fatalf("secret %q survived in %s (%d rows)", secret, column, n)
			}
		}
	}

	// The DLQ snapshot kept its replayable structure: the node row exists
	// with the redacted placeholder where the secrets sat.
	var nodeJSON string
	if err := pool.QueryRow(ctx,
		`SELECT node_json::text FROM dead_letters WHERE run_id = $1`, runID).Scan(&nodeJSON); err != nil {
		t.Fatalf("dead letter row: %v", err)
	}
	if !containsAll(nodeJSON, `"authorization": "[redacted]"`, `"password": "[redacted]"`, `"x-trace": "keep"`) {
		t.Fatalf("DLQ node snapshot must redact keys but keep structure: %s", nodeJSON)
	}
}

func containsAll(s string, subs ...string) bool {
	for _, sub := range subs {
		if !strings.Contains(s, sub) {
			return false
		}
	}
	return true
}
