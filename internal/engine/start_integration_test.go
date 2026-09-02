//go:build integration

package engine

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

func newHarness(t *testing.T) (context.Context, *pgxpool.Pool, *Engine, string) {
	t.Helper()
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set; run through `make test`")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	raw := make([]byte, 8)
	_, _ = rand.Read(raw)
	return ctx, pool, New(pool), "org-start-" + hex.EncodeToString(raw)
}

func mustParse(t *testing.T, doc string) *domain.Workflow {
	t.Helper()
	wf, issues := domain.Parse([]byte(doc))
	if len(issues) > 0 {
		t.Fatalf("fixture must parse clean: %+v", issues)
	}
	return wf
}

const linearDoc = `{"id":"wf-linear","nodes":[
	{"id":"first","type":"noop","config":{}},
	{"id":"second","type":"noop","config":{}}
],"edges":[{"from":"first","to":"second"}]}`

func TestStartRunCommitsSkeletonAtomically(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)

	// The wake-up notification must ride the same transaction: subscribe
	// before starting so the commit's NOTIFY lands here.
	listener, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire listener: %v", err)
	}
	defer listener.Release()
	if _, err := listener.Exec(ctx, "listen janusly_wake"); err != nil {
		t.Fatalf("listen: %v", err)
	}

	runID, err := eng.StartRun(ctx, StartInput{
		OrgID: org, Workflow: mustParse(t, linearDoc), CreatedBy: "tester",
	})
	if err != nil {
		t.Fatalf("start: %v", err)
	}

	q := store.New(pool)
	run, err := q.GetRun(ctx, store.GetRunParams{ID: runID, OrgID: org})
	if err != nil || run.Status != "running" || run.WorkflowVersionID != runID {
		t.Fatalf("unexpected run: %+v err=%v", run, err)
	}

	nodes, err := q.ListRunNodesByRun(ctx, runID)
	if err != nil || len(nodes) != 2 {
		t.Fatalf("expected two node rows: %+v err=%v", nodes, err)
	}
	byNode := map[string]store.ListRunNodesByRunRow{}
	for _, n := range nodes {
		byNode[n.NodeID] = n
	}
	// The root starts queued carrying its first attempt; the successor waits
	// pending with zero attempts — the contract's exact insert shape.
	if root := byNode["first"]; root.Status != "queued" || root.Attempts.Int32 != 1 {
		t.Fatalf("root shape wrong: %+v", root)
	}
	if next := byNode["second"]; next.Status != "pending" || next.Attempts.Int32 != 0 {
		t.Fatalf("successor shape wrong: %+v", next)
	}

	events, err := q.ListRunEvents(ctx, store.ListRunEventsParams{
		RunID: runID, BeforeCreatedAt: time.Now().Add(time.Hour), BeforeID: "zzz", PageLimit: 10,
	})
	// The start tx now also appends node.queued per root (the
	// contract's initial-publication event); newest-first keyset puts it
	// before run.started.
	if err != nil || len(events) != 2 ||
		events[0].Type != "node.queued" || events[0].NodeID.String != "first" ||
		events[1].Type != "run.started" {
		t.Fatalf("expected node.queued(first)+run.started: %+v err=%v", events, err)
	}
	var payload map[string]string
	_ = json.Unmarshal(events[1].Payload, &payload)
	if payload["workflowVersionId"] != runID {
		t.Fatalf("event payload contract mismatch: %s", events[0].Payload)
	}

	notifyCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	notification, err := listener.Conn().WaitForNotification(notifyCtx)
	if err != nil || notification.Payload != runID {
		t.Fatalf("expected committed NOTIFY with the run id, got %+v err=%v", notification, err)
	}
}

// flakyTx fails the Nth statement to prove nothing survives a mid-flight
// error.
type flakyTx struct {
	store.DBTX
	failOn int
	seen   int
}

func (f *flakyTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.seen++
	if f.seen == f.failOn {
		return pgconn.CommandTag{}, errors.New("injected failure")
	}
	return f.DBTX.Exec(ctx, sql, args...)
}

func TestStartRunLeavesNothingOnInjectedFailure(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	// Third statement = the second node insert: run and first node already
	// executed inside the transaction when the failure hits.
	eng.wrapTx = func(tx store.DBTX) store.DBTX { return &flakyTx{DBTX: tx, failOn: 3} }

	_, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, linearDoc)})
	if err == nil || !strings.Contains(err.Error(), "injected failure") {
		t.Fatalf("expected the injected failure, got %v", err)
	}

	var runs, nodes, events int
	_ = pool.QueryRow(ctx, "select count(*) from runs where org_id=$1", org).Scan(&runs)
	_ = pool.QueryRow(ctx, "select count(*) from run_nodes rn join runs r on r.id=rn.run_id where r.org_id=$1", org).Scan(&nodes)
	_ = pool.QueryRow(ctx, "select count(*) from run_events re join runs r on r.id=re.run_id where r.org_id=$1", org).Scan(&events)
	if runs != 0 || nodes != 0 || events != 0 {
		t.Fatalf("atomicity broken: runs=%d nodes=%d events=%d", runs, nodes, events)
	}
}

func TestStartRunResolvesDefaultsForTriggerPayloads(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	doc := `{"id":"wf-settings","nodes":[{"id":"only","type":"noop","config":{}}],"edges":[],
		"inputs":{"type":"object","properties":{
			"timeZone":{"type":"string","default":"Europe/Madrid"},
			"snoozeHours":{"type":"number","default":12}
		},"required":["timeZone","snoozeHours"]}}`

	runID, err := eng.StartRun(ctx, StartInput{
		OrgID: org, Workflow: mustParse(t, doc),
		Input: map[string]any{"triggeredBy": "webhook_received"},
	})
	if err != nil {
		t.Fatalf("trigger-style start must succeed via defaults: %v", err)
	}

	var inputJSON []byte
	if err := pool.QueryRow(ctx, "select input_json->'input' from runs where id=$1", runID).Scan(&inputJSON); err != nil {
		t.Fatalf("read persisted input: %v", err)
	}
	var persisted map[string]any
	_ = json.Unmarshal(inputJSON, &persisted)
	if persisted["timeZone"] != "Europe/Madrid" || persisted["snoozeHours"] != float64(12) || persisted["triggeredBy"] != "webhook_received" {
		t.Fatalf("persisted input must carry resolved defaults plus trigger keys: %v", persisted)
	}
}

func TestStartRunRejectsUnsatisfiedRequiredInput(t *testing.T) {
	ctx, _, eng, org := newHarness(t)
	doc := `{"nodes":[{"id":"only","type":"noop","config":{}}],"edges":[],
		"inputs":{"type":"object","properties":{"customer":{"type":"string"}},"required":["customer"]}}`

	_, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	var invalid *InputValidationError
	if !errors.As(err, &invalid) {
		t.Fatalf("expected InputValidationError, got %v", err)
	}
	if len(invalid.Errors) != 1 || invalid.Errors[0] != "$.customer is required" {
		t.Fatalf("error list contract mismatch: %v", invalid.Errors)
	}
}

func TestStartRunDiamondMarksOnlyTrueRootsQueued(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	doc := `{"nodes":[
		{"id":"root","type":"noop","config":{}},
		{"id":"left","type":"noop","config":{}},
		{"id":"right","type":"noop","config":{}},
		{"id":"join","type":"noop","config":{}}
	],"edges":[
		{"from":"root","to":"left"},{"from":"root","to":"right"},
		{"from":"left","to":"join"},{"from":"right","to":"join"}
	]}`
	runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: mustParse(t, doc)})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	var queued int
	_ = pool.QueryRow(ctx, "select count(*) from run_nodes where run_id=$1 and status='queued'", runID).Scan(&queued)
	if queued != 1 {
		t.Fatalf("exactly the true root must start queued, got %d", queued)
	}
}
