//go:build integration

package engine

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/go/internal/domain"
	"github.com/johnny4young/janusly/go/internal/grammar"
)

// A tenant org_configs row must bound the http executor without any node
// config: the 50ms tenant timeout kills a 300ms upstream, while an org with
// no row rides the platform default and succeeds.
func TestTenantHTTPBoundsGovernExecution(t *testing.T) {
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set")
	}
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()

	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(300 * time.Millisecond)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer slow.Close()

	eng := New(pool)
	dispatcher := eng.NewDispatcher(grammar.RenderOptions{})
	workerCtx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() { _ = eng.RunWorkers(workerCtx, 2, 20*time.Millisecond, dispatcher.Execute, quietLogger()) }()

	boundedOrg := fmt.Sprintf("org-bounds-%d", time.Now().UnixNano())
	freeOrg := boundedOrg + "-free"
	for _, row := range []struct{ key, value string }{{"http.timeoutMs", "50"}} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
			 VALUES ($1, $2, $3, $4, 'http', 'test', 'number')`,
			boundedOrg+"-"+row.key, boundedOrg, row.key, row.value); err != nil {
			t.Fatalf("seed config: %v", err)
		}
	}

	doc := `{"nodes":[{"id":"call","type":"http","config":{"url":"` + slow.URL + `"}}],"edges":[]}`
	wf, _ := domain.Parse([]byte(doc))

	start := func(org string) string {
		runID, err := eng.StartRun(ctx, StartInput{OrgID: org, Workflow: wf})
		if err != nil {
			t.Fatalf("start: %v", err)
		}
		return runID
	}
	waitTerminal := func(runID string) (status string, errJSON string) {
		deadline := time.Now().Add(20 * time.Second)
		for {
			row := pool.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1`, runID)
			if err := row.Scan(&status); err == nil && (status == "succeeded" || status == "failed") {
				var raw []byte
				_ = pool.QueryRow(ctx,
					`SELECT coalesce(error_json, '{}'::jsonb) FROM run_nodes WHERE run_id = $1 AND node_id = 'call'`,
					runID).Scan(&raw)
				return status, string(raw)
			}
			if time.Now().After(deadline) {
				t.Fatalf("run %s never terminal", runID)
			}
			time.Sleep(25 * time.Millisecond)
		}
	}

	status, errJSON := waitTerminal(start(boundedOrg))
	if status != "failed" || !strings.Contains(errJSON, "timed out after 50ms") {
		t.Fatalf("tenant bound must cut the call: %s %s", status, errJSON)
	}
	if status, _ := waitTerminal(start(freeOrg)); status != "succeeded" {
		t.Fatalf("default-bound org must succeed: %s", status)
	}
}

// The deferred hard cascade: expired tombstones purge with their versions
// and metadata atomically; fresh tombstones and active workflows survive.
func TestRetentionSweepPurgesExpiredTombstones(t *testing.T) {
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()
	eng := New(pool)

	org := fmt.Sprintf("org-retention-%d", time.Now().UnixNano())
	seed := func(id string, deletedDaysAgo int) {
		if _, err := pool.Exec(ctx,
			`INSERT INTO workflows (id, org_id, name) VALUES ($1, $2, 'flow')`, id, org); err != nil {
			t.Fatalf("seed workflow: %v", err)
		}
		for v := 1; v <= 2; v++ {
			if _, err := pool.Exec(ctx,
				`INSERT INTO workflow_versions (id, org_id, workflow_id, version, dag_json)
				 VALUES ($1, $2, $3, $4, '{}'::jsonb)`,
				fmt.Sprintf("%s-v%d", id, v), org, id, v); err != nil {
				t.Fatalf("seed version: %v", err)
			}
		}
		if deletedDaysAgo >= 0 {
			if _, err := pool.Exec(ctx,
				`UPDATE workflows SET deleted_at = now() - make_interval(days => $2) WHERE id = $1`,
				id, deletedDaysAgo); err != nil {
				t.Fatalf("tombstone: %v", err)
			}
		}
	}
	seed(org+"-expired", 31)
	seed(org+"-fresh", 1)
	seed(org+"-active", -1)

	deleted, err := eng.ProcessRetentionSweep(ctx, 30)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("purge count: %d", deleted)
	}
	var workflows, versions int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM workflows WHERE org_id = $1`, org).Scan(&workflows)
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM workflow_versions WHERE org_id = $1`, org).Scan(&versions)
	if workflows != 2 || versions != 4 {
		t.Fatalf("survivors: workflows=%d versions=%d", workflows, versions)
	}
}
