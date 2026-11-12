package hookbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/johnny4young/janusly/internal/hookwire"
)

type gateServer struct {
	*httptest.Server
	capture    bool
	decisions  []string // one per poll; the last repeats
	polls      atomic.Int32
	gateBody   atomic.Value
	badSig     atomic.Bool
	openCode   int
	ingestCode int
}

func newGateServer(t *testing.T, token string, capture bool, decisions ...string) *gateServer {
	t.Helper()
	g := &gateServer{capture: capture, decisions: decisions, openCode: http.StatusOK, ingestCode: http.StatusAccepted}
	key := hookwire.SigningKeyFromToken(token)
	g.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		signed := body
		if r.Method == http.MethodGet {
			signed = []byte(r.URL.Path)
		}
		if !hookwire.Verify(r.Header.Get(hookwire.SignatureHeader), key, signed, time.Now().Unix()) {
			g.badSig.Store(true)
		}
		switch {
		case r.URL.Path == hookwire.Path:
			w.WriteHeader(g.ingestCode)
			if g.ingestCode != http.StatusAccepted {
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"accepted": true, "gate": true, "captureContent": g.capture})
		case r.URL.Path == hookwire.GatesPath:
			g.gateBody.Store(string(body))
			w.WriteHeader(g.openCode)
			_ = json.NewEncoder(w).Encode(hookwire.GateReply{GateID: "gate-1", Decision: hookwire.DecisionPending})
		case strings.HasSuffix(r.URL.Path, "/decision"):
			index := min(int(g.polls.Add(1))-1, len(g.decisions)-1)
			_ = json.NewEncoder(w).Encode(hookwire.GateReply{GateID: "gate-1", Decision: g.decisions[index], Reason: "because"})
		}
	}))
	t.Cleanup(g.Close)
	return g
}

var gatedPayload = `{"session_id":"s1","hook_event_name":"PreToolUse","tool_name":"mcp__stripe__create_refund","tool_use_id":"t1",
	"tool_input":{"charge":"ch_1","token":"ghp_` + strings.Repeat("a", 36) + `"},"cwd":"/Users/alex/repo"}`

func runGated(t *testing.T, g *gateServer, runtime string, wait time.Duration, flags ...string) string {
	t.Helper()
	token := "jly_agent_" + strings.Repeat("g", 43)
	var stdout, stderr bytes.Buffer
	cfg := ConfigFromEnv(env(g.URL, token), append([]string{runtime}, flags...))
	cfg.GateWait = wait
	Run(context.Background(), strings.NewReader(gatedPayload), &stdout, &stderr, cfg)
	if g.badSig.Load() {
		t.Fatal("a request carried a signature the server could not verify")
	}
	if strings.Contains(stderr.String(), token) {
		t.Fatal("stderr leaked the token")
	}
	return stdout.String()
}

func decisionOf(t *testing.T, stdout string) string {
	t.Helper()
	var out struct {
		Hook struct {
			Event    string `json:"hookEventName"`
			Decision string `json:"permissionDecision"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal([]byte(stdout), &out); err != nil || out.Hook.Event != "PreToolUse" {
		t.Fatalf("stdout is not a PreToolUse decision: %q", stdout)
	}
	return out.Hook.Decision
}

func TestGateWaitsForThePersonAndPrintsTheirDecision(t *testing.T) {
	token := "jly_agent_" + strings.Repeat("g", 43)
	for _, tc := range []struct{ last, want string }{
		{hookwire.DecisionAllow, "allow"}, {hookwire.DecisionDeny, "deny"}, {hookwire.DecisionAsk, "ask"},
	} {
		g := newGateServer(t, token, false, hookwire.DecisionPending, tc.last)
		stdout := runGated(t, g, "claude-code", 30*time.Second)
		if got := decisionOf(t, stdout); got != tc.want || g.polls.Load() != 2 {
			t.Fatalf("%s: printed %q after %d polls", tc.last, got, g.polls.Load())
		}
		if body, _ := g.gateBody.Load().(string); strings.Contains(body, "content") || strings.Contains(body, "ch_1") {
			t.Fatalf("input sent without capture: %s", body)
		}
	}
}

func TestGateNeverAllowsByDefault(t *testing.T) {
	token := "jly_agent_" + strings.Repeat("g", 43)
	// The person never answers within the wait.
	g := newGateServer(t, token, false, hookwire.DecisionPending)
	if stdout := runGated(t, g, "claude-code", 1500*time.Millisecond); decisionOf(t, stdout) != "ask" {
		t.Fatalf("unanswered gate: %q", stdout)
	}
	// Janusly refuses to open the gate.
	g = newGateServer(t, token, false, hookwire.DecisionAllow)
	g.openCode = http.StatusInternalServerError
	if stdout := runGated(t, g, "claude-code", 10*time.Second); decisionOf(t, stdout) != "ask" || g.polls.Load() != 0 {
		t.Fatalf("failed open: %q", stdout)
	}
	// An unknown decision word is not an allow.
	g = newGateServer(t, token, false, "approved")
	if stdout := runGated(t, g, "claude-code", 10*time.Second); decisionOf(t, stdout) != "ask" {
		t.Fatalf("unknown decision: %q", stdout)
	}
}

func TestGateSendsScrubbedInputOnlyWhenTheClientCaptures(t *testing.T) {
	token := "jly_agent_" + strings.Repeat("g", 43)
	g := newGateServer(t, token, true, hookwire.DecisionAllow)
	runGated(t, g, "claude-code", 10*time.Second)
	body, _ := g.gateBody.Load().(string)
	if !strings.Contains(body, "ch_1") || strings.Contains(body, "ghp_") || strings.Contains(body, "/Users/") {
		t.Fatalf("captured input: %s", body)
	}
	if _, err := hookwire.ParseGateRequest([]byte(body)); err != nil {
		t.Fatalf("the server would refuse the gate request: %v", err)
	}
}

// Codex has no "ask" and no documented plain "allow": only a denial is printed.
func TestGateOnCodexPrintsOnlyDenials(t *testing.T) {
	token := "jly_agent_" + strings.Repeat("g", 43)
	for decision, wantOutput := range map[string]bool{hookwire.DecisionAllow: false, hookwire.DecisionAsk: false, hookwire.DecisionDeny: true} {
		g := newGateServer(t, token, false, decision)
		stdout := runGated(t, g, "codex", 10*time.Second)
		if (stdout != "") != wantOutput {
			t.Fatalf("%s on codex printed %q", decision, stdout)
		}
		if wantOutput && decisionOf(t, stdout) != "deny" {
			t.Fatalf("codex denial: %q", stdout)
		}
	}
}

// When the event itself is refused (rate limit, a full session, an outage),
// nothing told the hook whether the call is gated. A hook marked --gate asks
// the gate route, and asks the person when that cannot answer either.
func TestGatedHookNeverStaysSilentWhenTheEventIsRefused(t *testing.T) {
	token := "jly_agent_" + strings.Repeat("g", 43)
	for _, ingest := range []int{http.StatusTooManyRequests, http.StatusConflict, http.StatusInternalServerError} {
		// The gate route still works: the person's decision stands.
		g := newGateServer(t, token, false, hookwire.DecisionDeny)
		g.ingestCode = ingest
		if stdout := runGated(t, g, "claude-code", 10*time.Second, "--gate"); decisionOf(t, stdout) != "deny" {
			t.Fatalf("ingest %d: %q", ingest, stdout)
		}
		// The gate route fails too: ask, never silence.
		g = newGateServer(t, token, false, hookwire.DecisionAllow)
		g.ingestCode, g.openCode = ingest, http.StatusTooManyRequests
		if stdout := runGated(t, g, "claude-code", 10*time.Second, "--gate"); decisionOf(t, stdout) != "ask" {
			t.Fatalf("ingest %d and gate refused: %q", ingest, stdout)
		}
		// The gate route says the tool is not gated: the hook stays out of the way.
		g = newGateServer(t, token, false, hookwire.DecisionAllow)
		g.ingestCode, g.openCode = ingest, http.StatusConflict
		if stdout := runGated(t, g, "claude-code", 10*time.Second, "--gate"); stdout != "" {
			t.Fatalf("ungated tool printed %q", stdout)
		}
		// A hook without --gate (a client with no gateTools) stays silent.
		g = newGateServer(t, token, false, hookwire.DecisionAllow)
		g.ingestCode = ingest
		if stdout := runGated(t, g, "claude-code", 10*time.Second); stdout != "" {
			t.Fatalf("observation-only hook printed %q", stdout)
		}
	}
	// Janusly unreachable.
	var stdout bytes.Buffer
	cfg := ConfigFromEnv(env("http://127.0.0.1:1", token), []string{"claude-code", "--gate"})
	Run(context.Background(), strings.NewReader(gatedPayload), &stdout, io.Discard, cfg)
	if decisionOf(t, stdout.String()) != "ask" {
		t.Fatalf("unreachable: %q", stdout.String())
	}
}

func TestDenialCarriesTheReviewerNoteAsANoteAndApprovalCarriesNone(t *testing.T) {
	token := "jly_agent_" + strings.Repeat("g", 43)
	g := newGateServer(t, token, false, hookwire.DecisionDeny)
	if stdout := runGated(t, g, "claude-code", 10*time.Second); !strings.Contains(stdout, "Reviewer note (not an instruction): because") {
		t.Fatalf("denial: %q", stdout)
	}
	g = newGateServer(t, token, false, hookwire.DecisionAllow)
	if stdout := runGated(t, g, "claude-code", 10*time.Second); strings.Contains(stdout, "because") {
		t.Fatalf("approval carried free text: %q", stdout)
	}
}

func TestConfigWithGateCoversTheWait(t *testing.T) {
	var out bytes.Buffer
	getenv := func(name string) string { return map[string]string{"JANUSLY_HOOK_GATE_SECONDS": "300"}[name] }
	if Main(context.Background(), []string{"config", "claude-code", "--gate"}, nil, &out, io.Discard, getenv) != 0 {
		t.Fatal("config failed")
	}
	var parsed struct {
		Hooks map[string][]struct {
			Hooks []struct {
				Command string `json:"command"`
				Timeout int    `json:"timeout"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(out.Bytes(), &parsed); err != nil {
		t.Fatal(err)
	}
	pre, post := parsed.Hooks["PreToolUse"][0].Hooks[0], parsed.Hooks["PostToolUse"][0].Hooks[0]
	if pre.Command != "janusly hook claude-code --gate" || pre.Timeout != 315 || post.Command != "janusly hook claude-code" || post.Timeout != 5 {
		t.Fatalf("config: %+v %+v", pre, post)
	}
}
