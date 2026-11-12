package hookbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/hookwire"
)

var update = flag.Bool("update", false, "rewrite golden files")

var goldenNow = time.Date(2026, 11, 12, 15, 4, 5, 123_000_000, time.UTC)

// Each adapter turns a native payload into exactly the golden event, and no
// path, transcript, tool input, response or prompt survives the reduction.
func TestAdaptersMatchGoldenEvents(t *testing.T) {
	for _, runtime := range []string{hookwire.RuntimeClaudeCode, hookwire.RuntimeCodex} {
		inputs, err := filepath.Glob(filepath.Join("testdata", runtime, "*.input.json"))
		if err != nil || len(inputs) == 0 {
			t.Fatalf("%s: no fixtures (%v)", runtime, err)
		}
		for _, input := range inputs {
			raw, err := os.ReadFile(input)
			if err != nil {
				t.Fatal(err)
			}
			golden := strings.TrimSuffix(input, ".input.json") + ".golden.json"
			event, err := Build(raw, runtime, goldenNow)
			got := []byte("null\n")
			if err == nil {
				got, _ = json.MarshalIndent(event, "", "  ")
				got = append(got, '\n')
				if _, err := hookwire.Parse(bytes.TrimSpace(got), goldenNow); err != nil {
					t.Fatalf("%s: the server would refuse the event: %v", input, err)
				}
			} else if err != errIgnored {
				t.Fatalf("%s: %v", input, err)
			}
			for _, leak := range []string{"/Users/", "/home/", "transcript", ".jsonl", "hunter2", "credentials",
				"refund the duplicate", "git push", "ch_123", "Roadmap", "permission denied", "found 3 charges", "\"queued\""} {
				if strings.Contains(string(got), leak) {
					t.Fatalf("%s: %q left the machine:\n%s", input, leak, got)
				}
			}
			if *update {
				if err := os.WriteFile(golden, got, 0o644); err != nil {
					t.Fatal(err)
				}
				continue
			}
			want, err := os.ReadFile(golden)
			if err != nil {
				t.Fatalf("%s: %v (run with -update)", golden, err)
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("%s differs from golden:\n%s", input, got)
			}
		}
	}
}

func TestEventIDIsStableForARetryAndDistinctPerTurn(t *testing.T) {
	stop := func(prompt string) []byte {
		return []byte(`{"session_id":"s1","hook_event_name":"Stop","prompt_id":"` + prompt + `"}`)
	}
	first, _ := Build(stop("p-1"), hookwire.RuntimeClaudeCode, goldenNow)
	retry, _ := Build(stop("p-1"), hookwire.RuntimeClaudeCode, goldenNow.Add(time.Second))
	next, _ := Build(stop("p-2"), hookwire.RuntimeClaudeCode, goldenNow)
	if first.ID != retry.ID || first.ID == next.ID {
		t.Fatalf("ids: first %s retry %s next %s", first.ID, retry.ID, next.ID)
	}
}

func TestBuildRefusesSecretShapedIdentitiesAndBadPayloads(t *testing.T) {
	for _, raw := range []string{
		`{"session_id":"ghp_` + strings.Repeat("a", 36) + `","hook_event_name":"Stop"}`,
		`{"session_id":"s1","hook_event_name":"PreToolUse","tool_name":"mcp__AKIA` + strings.Repeat("Q", 16) + `__x"}`,
	} {
		if _, err := Build([]byte(raw), "", goldenNow); err != errIdentity {
			t.Fatalf("sent a secret-shaped identity: %v", err)
		}
	}
	for _, raw := range []string{``, `[]`, `{"hook_event_name":"Stop"}`, `{"session_id":"s1"}`,
		`{"session_id":"s1","hook_event_name":"PreToolUse"}`, `{"session_id":"s1","hook_event_name":"SubagentStart"}`} {
		if _, err := Build([]byte(raw), "", goldenNow); err != errNotAHook {
			t.Fatalf("%q: %v", raw, err)
		}
	}
}

func TestEndpointKeepsTheTokenOffPlainNetworks(t *testing.T) {
	for base, ok := range map[string]bool{
		"https://janusly.example.com": true, "http://127.0.0.1:3001": true, "http://localhost:3001/": false, "http://[::1]:3001": true,
		"https://x.example/?": false, "http://localhost.evil.com": false, "http://127.0.0.1.nip.io": false,
		"http://janusly.example.com": false, "ftp://x": false, "https://user:pw@x.example": false,
		"https://x.example?token=1": false, "": false, "janusly.example.com": false,
	} {
		if _, err := Endpoint(base); (err == nil) != ok {
			t.Fatalf("%q: %v", base, err)
		}
	}
}

// The hook never blocks the agent: it prints nothing on stdout and returns
// within the send timeout when Janusly hangs, and the server gets a valid
// signature over the exact body.
func TestRunSignsAndNeverBlocks(t *testing.T) {
	token := "jly_agent_" + strings.Repeat("k", 43)
	var gotBody []byte
	var gotSignature, gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		gotSignature, gotAuth = r.Header.Get(hookwire.SignatureHeader), r.Header.Get("Authorization")
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()
	var stdout, stderr bytes.Buffer
	payload := `{"session_id":"s1","hook_event_name":"Stop","cwd":"/Users/alex/x","transcript_path":"/Users/alex/t.jsonl"}`
	code := Main(context.Background(), []string{"claude-code"}, strings.NewReader(payload), &stdout, &stderr, env(server.URL, token))
	if code != 0 || stdout.Len() != 0 || stderr.Len() != 0 {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout.String(), stderr.String())
	}
	if gotAuth != "Bearer "+token || !hookwire.Verify(gotSignature, hookwire.SigningKeyFromToken(token), gotBody, time.Now().Unix()) {
		t.Fatalf("server could not verify: auth %q", gotAuth)
	}

	hang := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-hang }))
	defer slow.Close()
	defer close(hang)
	started := time.Now()
	stderr.Reset()
	code = Main(context.Background(), nil, strings.NewReader(payload), &stdout, &stderr, env(slow.URL, token))
	if elapsed := time.Since(started); code != 0 || elapsed > SendTimeout+time.Second || stdout.Len() != 0 {
		t.Fatalf("hung %s, code %d, stdout %q", elapsed, code, stdout.String())
	}
	if strings.Contains(stderr.String(), token) || strings.Contains(stderr.String(), "/Users/") {
		t.Fatalf("stderr leaked: %q", stderr.String())
	}

	stderr.Reset()
	if Main(context.Background(), nil, strings.NewReader(payload), &stdout, &stderr, env("http://janusly.example.com", token)) != 0 ||
		!strings.Contains(stderr.String(), "https") {
		t.Fatalf("plain remote URL: %q", stderr.String())
	}
}

func TestDoctorAndConfig(t *testing.T) {
	token := "jly_agent_" + strings.Repeat("d", 43)
	for status, want := range map[int]int{http.StatusBadRequest: 0, http.StatusUnauthorized: 1, http.StatusForbidden: 1, http.StatusNotFound: 1} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			if string(body) != "{}" {
				t.Errorf("doctor sent %q", body)
			}
			w.WriteHeader(status)
		}))
		var out bytes.Buffer
		if got := Main(context.Background(), []string{"doctor"}, nil, &out, io.Discard, env(server.URL, token)); got != want {
			t.Fatalf("HTTP %d: exit %d\n%s", status, got, out.String())
		}
		if strings.Contains(out.String(), token) {
			t.Fatal("doctor printed the token")
		}
		server.Close()
	}
	for _, runtime := range []string{"claude-code", "codex"} {
		var out bytes.Buffer
		if Main(context.Background(), []string{"config", runtime}, nil, &out, io.Discard, env("", "")) != 0 ||
			!json.Valid(out.Bytes()) || !strings.Contains(out.String(), "janusly hook "+runtime) {
			t.Fatalf("config %s: %s", runtime, out.String())
		}
	}
	if Main(context.Background(), []string{"config", "cursor"}, nil, io.Discard, io.Discard, env("", "")) != 2 {
		t.Fatal("unknown runtime accepted")
	}
}

func env(url, token string) func(string) string {
	return func(name string) string {
		switch name {
		case "JANUSLY_URL":
			return url
		case "JANUSLY_AGENT_TOKEN":
			return token
		}
		return ""
	}
}

func TestReductionDropsSpoofedAndSecretRefsAndInvisibleNames(t *testing.T) {
	spoofed := `{"session_id":"s1","hook_event_name":"PostToolUse","tool_name":"mcp__evil__x","mcp_server":"janusly","tool_use_id":"t",
		"tool_response":{"runId":"run_1"}}`
	event, err := Build([]byte(spoofed), hookwire.RuntimeClaudeCode, goldenNow)
	if err != nil || event.Data.JanuslyRefs != nil {
		t.Fatalf("refs from a non-Janusly tool: %+v %v", event.Data.JanuslyRefs, err)
	}
	secret := `{"session_id":"s1","hook_event_name":"PostToolUse","tool_name":"mcp__janusly__runs.start","tool_use_id":"t",
		"tool_response":{"runId":"ghp_` + strings.Repeat("a", 36) + `","workflowId":"wf_1"}}`
	event, err = Build([]byte(secret), hookwire.RuntimeClaudeCode, goldenNow)
	if err != nil || event.Data.JanuslyRefs == nil || event.Data.JanuslyRefs.RunID != "" || event.Data.JanuslyRefs.WorkflowID != "wf_1" {
		t.Fatalf("secret-shaped ref: %+v %v", event.Data.JanuslyRefs, err)
	}
	for cwd, want := range map[string]string{"/Users/a/fam\u200dily": "family", "/Users/a/evil\u202eexe": "evilexe", "/Users/a/..": "", "/": ""} {
		raw, _ := json.Marshal(map[string]any{"session_id": "s1", "hook_event_name": "SessionStart", "cwd": cwd})
		event, err := Build(raw, hookwire.RuntimeClaudeCode, goldenNow)
		if err != nil || event.Data.Project != want {
			t.Fatalf("cwd %q: project %q %v", cwd, event.Data.Project, err)
		}
		body, _ := json.Marshal(event)
		if _, err := hookwire.Parse(body, goldenNow); err != nil {
			t.Fatalf("cwd %q: the server would refuse it: %v", cwd, err)
		}
	}
}

func TestTokenFileWinsOverTheEnvironment(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte("jly_agent_fromfile\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := ConfigFromEnv(func(name string) string {
		return map[string]string{"JANUSLY_AGENT_TOKEN": "jly_agent_fromenv", "JANUSLY_AGENT_TOKEN_FILE": path}[name]
	}, nil)
	if cfg.Token != "jly_agent_fromfile" {
		t.Fatalf("token %q", cfg.Token)
	}
}
