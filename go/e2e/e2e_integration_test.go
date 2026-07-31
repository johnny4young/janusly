//go:build integration

package e2e

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// End to end against the REAL binary: compile cmd/api, boot it on ephemeral
// ports over the shared database, and drive the two README lifecycles over
// plain HTTP — the recovery wedge (fail → dead letter → heal → redrive →
// succeeded) and the operator gate (approval → resume → projected outputs).

var (
	buildOnce sync.Once
	binPath   string
	buildErr  error
)

func buildBinary(t *testing.T) string {
	t.Helper()
	buildOnce.Do(func() {
		// A stable temp dir: t.TempDir() would vanish with the first test
		// while later tests still exec the binary.
		dir, err := os.MkdirTemp("", "janusly-go-e2e-")
		if err != nil {
			buildErr = err
			return
		}
		binPath = filepath.Join(dir, "janusly-go-api")
		cmd := exec.Command("go", "build", "-o", binPath, "./cmd/api")
		cmd.Dir = ".."
		out, err := cmd.CombinedOutput()
		if err != nil {
			buildErr = fmt.Errorf("build: %v\n%s", err, out)
		}
	})
	if buildErr != nil {
		t.Fatal(buildErr)
	}
	return binPath
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("free port: %v", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

type binaryAPI struct {
	base     string
	internal string
	org      string
	cmd      *exec.Cmd
}

func bootBinary(t *testing.T) *binaryAPI {
	t.Helper()
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set; run through `make test`")
	}
	bin := buildBinary(t)
	port, internal := freePort(t), freePort(t)
	cmd := exec.Command(bin)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("JANUSLY_GO_PORT=%d", port),
		fmt.Sprintf("JANUSLY_GO_INTERNAL_PORT=%d", internal),
		"JANUSLY_GO_POLL_MS=50",
		"ALLOW_PRIVATE_HTTP_TARGETS=true",
	)
	logs := &bytes.Buffer{}
	cmd.Stdout, cmd.Stderr = logs, logs
	if err := cmd.Start(); err != nil {
		t.Fatalf("start binary: %v", err)
	}
	api := &binaryAPI{
		base:     fmt.Sprintf("http://127.0.0.1:%d", port),
		internal: fmt.Sprintf("http://127.0.0.1:%d", internal),
		org:      fmt.Sprintf("e2e-%d", time.Now().UnixNano()),
		cmd:      cmd,
	}
	t.Cleanup(func() {
		// SIGTERM must drain cleanly — the lifecycle contract.
		_ = cmd.Process.Signal(syscall.SIGTERM)
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			_ = cmd.Process.Kill()
			t.Errorf("binary did not drain on SIGTERM; logs:\n%s", logs.String())
		}
	})

	deadline := time.Now().Add(15 * time.Second)
	for {
		res, err := http.Get(api.base + "/healthz")
		if err == nil {
			res.Body.Close()
			if res.StatusCode == 200 {
				return api
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("binary never became healthy; logs:\n%s", logs.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (a *binaryAPI) call(t *testing.T, method, path string, body any) (int, map[string]any) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, a.base+path, reader)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-org-id", a.org)
	req.Header.Set("x-user-id", "e2e")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	var parsed map[string]any
	_ = json.NewDecoder(res.Body).Decode(&parsed)
	return res.StatusCode, parsed
}

func (a *binaryAPI) data(t *testing.T, method, path string, body any) map[string]any {
	t.Helper()
	status, res := a.call(t, method, path, body)
	data, ok := res["data"].(map[string]any)
	if !ok {
		t.Fatalf("%s %s: no data (%d): %v", method, path, status, res)
	}
	return data
}

func (a *binaryAPI) waitRun(t *testing.T, runID, want string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(25 * time.Second)
	for {
		view := a.data(t, "GET", "/v1/run?runId="+runID, nil)
		run := view["run"].(map[string]any)
		if run["status"] == want {
			return view
		}
		if time.Now().After(deadline) {
			t.Fatalf("run %s stuck at %v, want %s", runID, run["status"], want)
		}
		time.Sleep(60 * time.Millisecond)
	}
}

func TestRecoveryWedgeLifecycleOverTheRealBinary(t *testing.T) {
	api := bootBinary(t)

	var healed bool
	var mu sync.Mutex
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		ok := healed
		mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"restored":true}`))
	}))
	defer upstream.Close()

	workflow := map[string]any{
		"id":   "e2e-wedge-" + api.org,
		"name": "E2E recovery wedge",
		"nodes": []any{
			map[string]any{"id": "call", "type": "http", "config": map[string]any{
				"url":   upstream.URL,
				"retry": map[string]any{"maxAttempts": 2, "delayMs": 50},
			}},
			map[string]any{"id": "after", "type": "transform", "config": map[string]any{
				"mapping": map[string]any{"code": "{{context.call.output.statusCode}}"},
			}},
		},
		"edges": []any{map[string]any{"from": "call", "to": "after"}},
	}

	saved := api.data(t, "POST", "/v1/workflows/save", workflow)
	if saved["version"] != float64(1) {
		t.Fatalf("save: %v", saved)
	}
	runID := api.data(t, "POST", "/v1/start", map[string]any{"workflow": workflow})["runId"].(string)
	api.waitRun(t, runID, "failed")

	status, list := api.call(t, "GET", "/v1/dlq?limit=50", nil)
	if status != 200 {
		t.Fatalf("dlq list: %d", status)
	}
	var deadLetterID string
	for _, item := range list["data"].([]any) {
		row := item.(map[string]any)
		if row["runId"] == runID {
			deadLetterID = row["id"].(string)
		}
	}
	if deadLetterID == "" {
		t.Fatal("dead letter expected")
	}

	mu.Lock()
	healed = true
	mu.Unlock()
	api.data(t, "POST", "/v1/dlq/redrive", map[string]any{"deadLetterId": deadLetterID})
	view := api.waitRun(t, runID, "succeeded")

	for _, raw := range view["nodes"].([]any) {
		node := raw.(map[string]any)
		if node["nodeId"] == "after" && node["status"] != "succeeded" {
			t.Fatalf("downstream must complete after the redrive: %v", node)
		}
	}
}

func TestApprovalGateLifecycleOverTheRealBinary(t *testing.T) {
	api := bootBinary(t)

	workflow := map[string]any{
		"id":   "e2e-gate-" + api.org,
		"name": "E2E approval gate",
		"inputs": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"requester": map[string]any{"type": "string", "default": "ops-team"},
			},
			"required": []any{"requester"},
		},
		"outputs": map[string]any{
			"who":     "{{inputs.requester}}",
			"release": "{{context.after.output.released}}",
		},
		"nodes": []any{
			map[string]any{"id": "gate", "type": "approval", "config": map[string]any{"message": "Ship?"}},
			map[string]any{"id": "after", "type": "transform", "config": map[string]any{
				"mapping": map[string]any{"released": true},
			}},
		},
		"edges": []any{map[string]any{"from": "gate", "to": "after"}},
	}

	api.data(t, "POST", "/v1/workflows/save", workflow)
	runID := api.data(t, "POST", "/v1/start", map[string]any{"workflow": workflow})["runId"].(string)

	deadline := time.Now().Add(20 * time.Second)
	for {
		view := api.data(t, "GET", "/v1/run?runId="+runID, nil)
		waiting := false
		for _, raw := range view["nodes"].([]any) {
			node := raw.(map[string]any)
			if node["nodeId"] == "gate" && node["status"] == "waiting" {
				waiting = true
			}
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("gate never waited")
		}
		time.Sleep(60 * time.Millisecond)
	}

	api.data(t, "POST", "/v1/resume", map[string]any{"runId": runID, "nodeId": "gate"})
	view := api.waitRun(t, runID, "succeeded")

	outputRaw, _ := json.Marshal(view["run"].(map[string]any)["outputJson"])
	if !strings.Contains(string(outputRaw), `"who":"ops-team"`) &&
		!strings.Contains(string(outputRaw), `"who": "ops-team"`) {
		t.Fatalf("declared outputs must project the defaulted input: %s", outputRaw)
	}
	if !strings.Contains(string(outputRaw), `"release":true`) {
		t.Fatalf("declared outputs must read downstream state: %s", outputRaw)
	}
}

func TestEngineMetricsExposeOnTheInternalPort(t *testing.T) {
	api := bootBinary(t)
	workflow := map[string]any{
		"nodes": []any{
			map[string]any{"id": "a", "type": "noop", "config": map[string]any{}},
			map[string]any{"id": "b", "type": "transform", "config": map[string]any{
				"mapping": map[string]any{"ok": true},
			}},
		},
		"edges": []any{map[string]any{"from": "a", "to": "b"}},
	}
	runID := api.data(t, "POST", "/v1/start", map[string]any{"workflow": workflow})["runId"].(string)
	api.waitRun(t, runID, "succeeded")

	res, err := http.Get(api.internal + "/metrics")
	if err != nil {
		t.Fatalf("scrape: %v", err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	body := string(raw)
	for _, series := range []string{
		"janusly_go_claims_total",
		`janusly_go_node_completions_total{outcome="succeeded"}`,
		"janusly_go_node_execution_seconds_bucket",
		`janusly_go_runs_terminal_total{status="succeeded"}`,
		`janusly_go_queue_depth{state="queued"}`,
	} {
		if !strings.Contains(body, series) {
			t.Fatalf("metric series %s missing from scrape", series)
		}
	}
}
