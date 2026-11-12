//go:build integration

package main

import (
	"bytes"
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/johnny4young/janusly/internal/agentclient"
	"github.com/johnny4young/janusly/internal/store"
)

// `janusly hook` reports a session to a running `janusly`, and `hook doctor`
// confirms the setup, without the token reaching either side's output.
func TestExecutableHookReportsToTheServer(t *testing.T) {
	baseDSN := os.Getenv("JANUSLY_DATABASE_URL")
	if baseDSN == "" {
		t.Skip("JANUSLY_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 120*time.Second)
	defer cancel()
	dsn, pool := runtimeTestDatabase(t, ctx, baseDSN)
	org, creator := "hook-exe-"+uuid.NewString()[:8], "creator-"+uuid.NewString()[:8]
	if _, err := pool.Exec(ctx, `INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, 'editor')`,
		uuid.NewString(), org, creator); err != nil {
		t.Fatal(err)
	}
	q := store.New(pool)
	held, err := agentclient.CreatorPermissions(ctx, q, org, creator)
	if err != nil {
		t.Fatal(err)
	}
	issued, err := agentclient.Issue(ctx, q, uuid.NewString(), time.Now(), agentclient.IssueInput{
		OrgID: org, CreatedBy: creator, Name: "hook exe", Capabilities: []string{"report"},
	}, held)
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(t.TempDir(), "janusly")
	if out, err := exec.CommandContext(ctx, "go", "build", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatalf("build executable: %v\n%s", err, out)
	}

	port, internalPort := runtimeTestPorts(t)
	logs := &lockedBuffer{}
	server := exec.Command(binary)
	server.Env = []string{
		"PATH=" + os.Getenv("PATH"), "JANUSLY_ENV=test", "OTEL_EXPORTER=none", "JANUSLY_HTTP_HOST=127.0.0.1",
		"JANUSLY_DATABASE_URL=" + dsn, "JANUSLY_PORT=" + port, "JANUSLY_INTERNAL_PORT=" + internalPort,
		"JANUSLY_WORKER_CONCURRENCY=1", "JANUSLY_POLL_MS=50", "JANUSLY_MCP_HTTP_ENABLED=true",
	}
	server.Stdout, server.Stderr = logs, logs
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- server.Wait() }()
	defer func() {
		_ = server.Process.Kill()
		<-done
		if strings.Contains(logs.String(), issued.Token) {
			t.Error("the token reached the server logs")
		}
		if t.Failed() {
			t.Logf("runtime log:\n%s", logs.String())
		}
	}()
	base := "http://127.0.0.1:" + port
	probe := &http.Client{Timeout: 200 * time.Millisecond}
	runtimeWait(t, ctx, func() bool {
		res, err := probe.Get(base + "/healthz")
		if err != nil {
			return false
		}
		_ = res.Body.Close()
		return res.StatusCode == http.StatusOK
	})

	hook := func(stdin string, args ...string) (int, string, string) {
		cmd := exec.CommandContext(ctx, binary, append([]string{"hook"}, args...)...)
		cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "JANUSLY_URL=" + base, "JANUSLY_AGENT_TOKEN=" + issued.Token}
		cmd.Stdin = strings.NewReader(stdin)
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		err := cmd.Run()
		code := 0
		if exit, ok := err.(*exec.ExitError); ok {
			code = exit.ExitCode()
		} else if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(stdout.String()+stderr.String(), issued.Token) {
			t.Fatal("the hook printed the token")
		}
		return code, stdout.String(), stderr.String()
	}

	if code, out, _ := hook("", "doctor"); code != 0 || !strings.Contains(out, "signature accepted") {
		t.Fatalf("doctor: %d %s", code, out)
	}
	session := "exe-" + uuid.NewString()
	for _, payload := range []string{
		`{"session_id":"` + session + `","hook_event_name":"SessionStart","cwd":"/Users/alex/work/billing","transcript_path":"/Users/alex/t.jsonl","model":"opus"}`,
		`{"session_id":"` + session + `","hook_event_name":"PostToolUse","tool_name":"mcp__notion__search","tool_use_id":"t1","tool_input":{"q":"secret"},"duration_ms":40}`,
	} {
		if code, out, errOut := hook(payload, "claude-code"); code != 0 || out != "" || errOut != "" {
			t.Fatalf("hook: %d %q %q", code, out, errOut)
		}
	}
	var project string
	var events int
	if err := pool.QueryRow(ctx, `SELECT project, event_count FROM agent_sessions WHERE org_id = $1 AND external_session_id = $2`,
		org, session).Scan(&project, &events); err != nil {
		t.Fatal(err)
	}
	if project != "billing" || events != 2 {
		t.Fatalf("stored session: %q %d", project, events)
	}

	// Janusly down: the hook still exits 0 within its budget.
	cmd := exec.CommandContext(ctx, binary, "hook", "claude-code")
	cmd.Env = []string{"JANUSLY_URL=http://127.0.0.1:1", "JANUSLY_AGENT_TOKEN=" + issued.Token}
	cmd.Stdin = strings.NewReader(`{"session_id":"x","hook_event_name":"Stop"}`)
	started := time.Now()
	if err := cmd.Run(); err != nil || time.Since(started) > 5*time.Second {
		t.Fatalf("hook with Janusly down: %v after %s", err, time.Since(started))
	}
}
