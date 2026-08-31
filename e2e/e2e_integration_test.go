//go:build integration

package e2e

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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

const (
	e2eBuildCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	e2eBuildTree   = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func buildBinary(t *testing.T) string {
	t.Helper()
	buildOnce.Do(func() {
		// A stable temp dir: t.TempDir() would vanish with the first test
		// while later tests still exec the binary.
		dir, err := os.MkdirTemp("", "janusly-e2e-")
		if err != nil {
			buildErr = err
			return
		}
		binPath = filepath.Join(dir, "janusly-api")
		ldflags := "-X github.com/johnny4young/janusly/internal/buildinfo.buildCommit=" + e2eBuildCommit +
			" -X github.com/johnny4young/janusly/internal/buildinfo.buildTree=" + e2eBuildTree
		cmd := exec.Command("go", "build", "-trimpath", "-buildvcs=false", "-ldflags", ldflags,
			"-o", binPath, "./cmd/api")
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
	dsn := os.Getenv("JANUSLY_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_DATABASE_URL not set; run through `make test`")
	}
	bin := buildBinary(t)
	port, internal := freePort(t), freePort(t)
	cmd := exec.Command(bin)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("JANUSLY_PORT=%d", port),
		fmt.Sprintf("JANUSLY_INTERNAL_PORT=%d", internal),
		"JANUSLY_POLL_MS=50",
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
		"janusly_claims_total",
		`janusly_node_completions_total{outcome="succeeded"}`,
		"janusly_node_execution_seconds_bucket",
		`janusly_runs_terminal_total{status="succeeded"}`,
		`janusly_queue_depth{state="queued"}`,
	} {
		if !strings.Contains(body, series) {
			t.Fatalf("metric series %s missing from scrape", series)
		}
	}
	if !strings.Contains(body, `node_type="noop"`) || !strings.Contains(body, `node_type="transform"`) {
		t.Fatalf("execution histogram must retain the bounded node_type dimension")
	}
}

func TestInternalBuildIdentityMatchesTheFinishedBinary(t *testing.T) {
	api := bootBinary(t)
	res, err := http.Get(api.internal + "/build")
	if err != nil {
		t.Fatalf("get build identity: %v", err)
	}
	defer res.Body.Close()
	var identity struct {
		SchemaVersion  int    `json:"schemaVersion"`
		Commit         string `json:"commit"`
		Tree           string `json:"tree"`
		ArtifactSHA256 string `json:"artifactSha256"`
		Verified       bool   `json:"verified"`
	}
	if err := json.NewDecoder(res.Body).Decode(&identity); err != nil {
		t.Fatalf("decode build identity: %v", err)
	}
	body, err := os.ReadFile(buildBinary(t))
	if err != nil {
		t.Fatalf("read built binary: %v", err)
	}
	wantDigest := fmt.Sprintf("%x", sha256.Sum256(body))
	if res.StatusCode != http.StatusOK || res.Header.Get("Cache-Control") != "no-store" ||
		identity.SchemaVersion != 1 || identity.Commit != e2eBuildCommit || identity.Tree != e2eBuildTree ||
		identity.ArtifactSHA256 != wantDigest || !identity.Verified {
		t.Fatalf("unexpected build identity status=%d cache=%q identity=%+v wantDigest=%s",
			res.StatusCode, res.Header.Get("Cache-Control"), identity, wantDigest)
	}
}

// The consistency metric names scrape with the contract's exact spellings,
// and a bind conflict on the internal port aborts the boot hard.
func TestMetricsConsistencyNamesAndBindConflict(t *testing.T) {
	api := bootBinary(t)
	res, err := http.Get(api.internal + "/metrics")
	if err != nil {
		t.Fatalf("scrape: %v", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	text := string(body)
	for _, name := range []string{
		"workflow_queue_waiting_jobs",
		"workflow_queue_active_jobs",
		"maintenance_queue_waiting_jobs",
		"maintenance_queue_active_jobs",
		"janusly_rate_limit_degraded_buckets",
		`target_info{service_instance_id=`,
		`service_name="janusly"`,
		`service_namespace="janusly"`,
	} {
		if !strings.Contains(text, name) {
			t.Fatalf("scrape missing %q", name)
		}
	}

	// Bind conflict: hold the internal port ourselves, then boot — the
	// process must exit non-zero instead of serving half its surface.
	holder, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("holder: %v", err)
	}
	defer holder.Close()
	taken := holder.Addr().(*net.TCPAddr).Port
	conflict := exec.Command(buildBinary(t))
	conflict.Env = append(os.Environ(),
		fmt.Sprintf("JANUSLY_PORT=%d", freePort(t)),
		fmt.Sprintf("JANUSLY_INTERNAL_PORT=%d", taken),
	)
	out := &bytes.Buffer{}
	conflict.Stdout, conflict.Stderr = out, out
	if err := conflict.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- conflict.Wait() }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatalf("bind conflict must exit non-zero; logs:\n%s", out.String())
		}
	case <-time.After(20 * time.Second):
		_ = conflict.Process.Kill()
		t.Fatalf("bind conflict must abort the boot; logs:\n%s", out.String())
	}
}

// A valid PromQL query against a renamed/nonexistent family fails silently:
// Grafana says "no data" and the alert never fires. Compare every configured
// Janusly family with a scrape from the exact executable instead.
func TestAlertsAndDashboardOnlyNameMetricsTheBinaryExposes(t *testing.T) {
	api := bootBinary(t)
	workflow := map[string]any{
		"nodes": []any{map[string]any{
			"id": "a", "type": "transform",
			"config": map[string]any{"mapping": map[string]any{"ok": true}},
		}},
		"edges": []any{},
	}
	runID := api.data(t, "POST", "/v1/start", map[string]any{"workflow": workflow})["runId"].(string)
	api.waitRun(t, runID, "succeeded")

	res, err := http.Get(api.internal + "/metrics")
	if err != nil {
		t.Fatalf("scrape: %v", err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	exposed := map[string]bool{}
	for _, line := range strings.Split(string(raw), "\n") {
		if fields := strings.Fields(line); len(fields) >= 3 && fields[0] == "#" && fields[1] == "TYPE" {
			exposed[fields[2]] = true
		}
	}
	if len(exposed) == 0 {
		t.Fatal("scrape exposed no metric families")
	}

	family := func(name string) string {
		for _, suffix := range []string{"_bucket", "_sum", "_count"} {
			if trimmed, ok := strings.CutSuffix(name, suffix); ok {
				return trimmed
			}
		}
		return name
	}
	referenced := regexp.MustCompile(`\b(?:janusly|workflow|maintenance)_[a-z_]+`)
	for _, path := range []string{
		"../deploy/observability/prometheus/rules.yml",
		"../deploy/observability/grafana/dashboards/janusly-operations.json",
	} {
		source, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		seen := map[string]bool{}
		for _, match := range referenced.FindAllString(string(source), -1) {
			name := family(match)
			if seen[name] {
				continue
			}
			seen[name] = true
			if !exposed[name] {
				t.Errorf("%s names %q, which the executable does not expose", path, name)
			}
		}
	}
}
