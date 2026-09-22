//go:build integration

package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/engine"
	"github.com/johnny4young/janusly/internal/migrate"
	"github.com/johnny4young/janusly/internal/store"
)

// Use a real executable and a new database: its workers must never consume
// another integration test's queued fixtures. No provider credentials enter
// the child process. The external credential names this same throwaway DB.
func TestExecutableDrainsExternalDatabaseQuery(t *testing.T) {
	for _, mode := range []string{"api", "mcp"} {
		t.Run(mode, func(t *testing.T) { testExecutableDrainsExternalDatabaseQuery(t, mode) })
	}
}

func testExecutableDrainsExternalDatabaseQuery(t *testing.T, mode string) {
	t.Helper()
	baseDSN := os.Getenv("JANUSLY_DATABASE_URL")
	if baseDSN == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	dsn, pool := runtimeTestDatabase(t, ctx, baseDSN)
	binary := filepath.Join(t.TempDir(), "janusly")
	build := exec.CommandContext(ctx, "go", "build", "-o", binary, "../"+mode)
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build executable: %v\n%s", err, out)
	}
	marker := "runtime-external-" + uuid.NewString()
	externalDSN := runtimeTestDSN(t, dsn, "", marker)
	if err := store.New(pool).InsertCredential(ctx, store.InsertCredentialParams{
		ID: "runtime-db", OrgID: "runtime-org", Name: "external", Kind: "postgres", SecretRef: "RUNTIME_DB_DSN",
	}); err != nil {
		t.Fatal(err)
	}
	port, internalPort := runtimeTestPorts(t)
	logPath := filepath.Join(t.TempDir(), "runtime.log")
	log, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = log.Close() }()
	child := exec.Command(binary)
	child.Env = []string{
		"PATH=" + os.Getenv("PATH"), "JANUSLY_ENV=test", "OTEL_EXPORTER=none",
		"JANUSLY_DATABASE_URL=" + dsn, "JANUSLY_PORT=" + port, "JANUSLY_INTERNAL_PORT=" + internalPort,
		"JANUSLY_PERSIST_MAX_BYTES=2", "JANUSLY_DB_TOOL_MAX_PROCESS_POOLS=1", "JANUSLY_WORKER_CONCURRENCY=1", "JANUSLY_POLL_MS=50",
		"JANUSLY_CREDENTIAL_ENV_ALLOWLIST=RUNTIME_DB_DSN", "RUNTIME_DB_DSN=" + externalDSN,
	}
	var stdin io.WriteCloser
	if mode == "mcp" {
		stdin, err = child.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = stdin.Close() }()
	}
	child.Stdout, child.Stderr = log, log
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	stopped := false
	defer func() {
		if !stopped {
			_ = child.Process.Kill()
			<-done
		}
		if t.Failed() {
			data, _ := os.ReadFile(logPath)
			t.Logf("runtime log:\n%s", data)
		}
	}()
	client := &http.Client{Timeout: 200 * time.Millisecond}
	runtimeWait(t, ctx, func() bool {
		if mode == "mcp" {
			data, err := os.ReadFile(logPath)
			if err != nil {
				t.Fatal(err)
			}
			return strings.Contains(string(data), "mcp server ready")
		}
		response, err := client.Get("http://127.0.0.1:" + port + "/healthz")
		if err != nil {
			return false
		}
		_ = response.Body.Close()
		return response.StatusCode == http.StatusOK
	})
	wf, issues := domain.Parse([]byte(`{"id":"runtime-db","nodes":[{"id":"query","type":"tool","config":{"tool":"db.query.read","input":{"credential":"external","sql":"select 1 AS value from pg_sleep(2)","timeoutMs":5000},"resultPolicy":"require_ok"}}],"edges":[]}`))
	if len(issues) != 0 {
		t.Fatalf("workflow fixture: %v", issues)
	}
	runID, err := engine.New(pool).StartRun(ctx, engine.StartInput{OrgID: "runtime-org", Workflow: wf})
	if err != nil {
		t.Fatal(err)
	}
	runtimeWait(t, ctx, func() bool {
		var active bool
		err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND state = 'active' AND query LIKE '%pg_sleep%')`, marker).Scan(&active)
		if err != nil {
			t.Fatal(err)
		}
		return active
	})
	if mode == "mcp" {
		if err := stdin.Close(); err != nil {
			t.Fatal(err)
		}
	} else if err := child.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		stopped = true
		if err != nil {
			t.Fatalf("graceful exit: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("executable did not drain")
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1`, runID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "succeeded" {
		t.Fatalf("shutdown lost in-flight query: %s", status)
	}
	// The process, not this fixture's engine, completes the node. Both roots
	// must inject the configured event cap while preserving durable output.
	var eventPayload string
	if err := pool.QueryRow(ctx, `SELECT payload::text FROM run_events WHERE run_id=$1 AND type='node.succeeded'`, runID).Scan(&eventPayload); err != nil {
		t.Fatal(err)
	}
	if eventPayload != "{}" {
		t.Fatalf("%s executable ignored persistence policy: %s", mode, eventPayload)
	}
	var remaining int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE application_name = $1`, marker).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("external sessions after shutdown=%d", remaining)
	}
	data, err := os.ReadFile(logPath)
	if err != nil || !strings.Contains(string(data), "external database pools drained") {
		t.Fatalf("runtime did not execute pool drain: %v", err)
	}
}

func runtimeTestDatabase(t *testing.T, ctx context.Context, baseDSN string) (string, *pgxpool.Pool) {
	t.Helper()
	admin, err := pgxpool.New(ctx, baseDSN)
	if err != nil {
		t.Fatal(err)
	}
	name := "janusly_runtime_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	// The database name is generated here; never drop a caller-supplied DB.
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, err := admin.Exec(cleanup, "DROP DATABASE "+pgx.Identifier{name}.Sanitize())
		admin.Close()
		if err != nil {
			t.Errorf("remove isolated runtime database: %v", err)
		}
	})
	dsn := runtimeTestDSN(t, baseDSN, name, "")
	if err := migrate.Up(ctx, dsn); err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return dsn, pool
}

func runtimeTestDSN(t *testing.T, dsn, database, application string) string {
	t.Helper()
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		parsed, err := url.Parse(dsn)
		if err != nil {
			t.Fatal("invalid test database URL")
		}
		query := parsed.Query()
		if database != "" {
			query.Set("dbname", database)
		}
		if application != "" {
			query.Set("application_name", application)
		}
		parsed.RawQuery = query.Encode()
		return parsed.String()
	}
	if database != "" {
		dsn += " dbname=" + database
	}
	if application != "" {
		dsn += " application_name=" + application
	}
	return dsn
}

func runtimeTestPorts(t *testing.T) (string, string) {
	t.Helper()
	var ports []string
	for range 2 {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = listener.Close() }()
		ports = append(ports, fmt.Sprint(listener.Addr().(*net.TCPAddr).Port))
	}
	return ports[0], ports[1]
}

func runtimeWait(t *testing.T, ctx context.Context, ready func() bool) {
	t.Helper()
	deadline, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for !ready() {
		select {
		case <-deadline.Done():
			t.Fatal("runtime condition timed out")
		case <-ticker.C:
		}
	}
}
