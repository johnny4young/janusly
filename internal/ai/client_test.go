package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/johnny4young/janusly/internal/ai/failcat"
	"github.com/johnny4young/janusly/internal/usage"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func fakeProvider(t *testing.T, status int, body string, delay time.Duration) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if delay > 0 {
			time.Sleep(delay)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return server
}

const successBody = `{"id":"msg_1","type":"message","role":"assistant",
"model":"claude-haiku-4-5-20251001",
"content":[{"type":"text","text":"hola desde el simulador"}],
"stop_reason":"end_turn",
"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":2,"cache_creation_input_tokens":1}}`

func TestGenerateTextRejectsInvalidProviderUsageAccounting(t *testing.T) {
	for name, usage := range map[string]string{
		"negative":          `{"input_tokens":-1,"output_tokens":5}`,
		"quantity overflow": `{"input_tokens":2147483647,"output_tokens":1}`,
	} {
		t.Run(name, func(t *testing.T) {
			body := `{"id":"msg_bad","type":"message","role":"assistant","model":"claude-haiku-4-5-20251001",` +
				`"content":[{"type":"text","text":"bad"}],"stop_reason":"end_turn","usage":` + usage + `}`
			server := fakeProvider(t, http.StatusOK, body, 0)
			result, aiErr := New(Config{APIKey: "test-key", BaseURL: server.URL}).GenerateText(
				context.Background(), GenerateTextInput{Prompt: "hello"},
			)
			if result != nil || aiErr == nil || aiErr.Class != "unknown" ||
				aiErr.Message != "provider returned invalid usage accounting" {
				t.Fatalf("invalid usage was accepted: result=%+v err=%+v", result, aiErr)
			}
		})
	}
}

// The SDK error matrix: every failure mode classifies into the stable
// AIError vocabulary — never a raw SDK error, never a panic.
func TestGenerateTextClassifiesEveryFailure(t *testing.T) {
	// The shared failure catalog drives this suite — adding a case there
	// exercises the chokepoint here automatically.
	for _, tc := range failcat.Wire() {
		t.Run(tc.Name, func(t *testing.T) {
			var baseURL string
			if tc.Status == 0 {
				baseURL = "http://127.0.0.1:1"
			} else {
				server := httptest.NewServer(failcat.Handler(tc))
				t.Cleanup(server.Close)
				baseURL = server.URL
			}
			client := New(Config{APIKey: "test-key", BaseURL: baseURL, TimeoutMs: 300})
			result, aiErr := client.GenerateText(context.Background(), GenerateTextInput{Prompt: "hi"})
			if result != nil || aiErr == nil {
				t.Fatalf("must fail classified: %+v %v", result, aiErr)
			}
			// network_dead may race the client timeout — both classes are
			// honest for a dead endpoint.
			deadRace := tc.Name == "network_dead" && aiErr.Class == "timeout"
			if aiErr.Class != tc.WantClass && !deadRace {
				t.Fatalf("class: want %s got %s (%s)", tc.WantClass, aiErr.Class, aiErr.Message)
			}
		})
	}

	// Network: a dead endpoint (nothing listening).
	client := New(Config{APIKey: "k", BaseURL: "http://127.0.0.1:1", TimeoutMs: 500})
	if _, aiErr := client.GenerateText(context.Background(), GenerateTextInput{Prompt: "x"}); aiErr == nil ||
		(aiErr.Class != "network" && aiErr.Class != "timeout") {
		t.Fatalf("dead endpoint must classify network/timeout: %+v", aiErr)
	}

	// No API key: class no_client without ever dialing.
	unconfigured := New(Config{})
	if unconfigured.Configured() {
		t.Fatal("empty key must read unconfigured")
	}
	if _, aiErr := unconfigured.GenerateText(context.Background(), GenerateTextInput{Prompt: "x"}); aiErr == nil || aiErr.Class != "no_client" {
		t.Fatalf("no key must be no_client: %+v", aiErr)
	}

	// A foreign provider hint is an invalid request, not a dial.
	hinted := New(Config{APIKey: "k", BaseURL: "http://127.0.0.1:1"})
	if _, aiErr := hinted.GenerateText(context.Background(), GenerateTextInput{
		Prompt: "x", ModelHint: "openai/gpt-4o",
	}); aiErr == nil || aiErr.Class != "invalid_request" {
		t.Fatalf("foreign provider hint: %+v", aiErr)
	}
	for _, invalid := range []string{
		"anthropic/CLAUDE-HAIKU", "anthropic/claude/haiku", "claude haiku",
		strings.Repeat("a", MaxModelIDBytes+1),
	} {
		if _, aiErr := hinted.GenerateText(context.Background(), GenerateTextInput{
			Prompt: "x", ModelHint: invalid,
		}); aiErr == nil || aiErr.Class != "invalid_request" || len(aiErr.Error()) > 200 {
			preview := invalid[:min(len(invalid), 40)]
			t.Fatalf("invalid model hint %q was not rejected with a bounded error: %+v", preview, aiErr)
		}
	}
	invalidConfigured := New(Config{
		APIKey: "k", Model: strings.Repeat("a", MaxModelIDBytes+1), BaseURL: "http://127.0.0.1:1",
	})
	if _, aiErr := invalidConfigured.GenerateText(context.Background(), GenerateTextInput{Prompt: "x"}); aiErr == nil || aiErr.Class != "invalid_request" {
		t.Fatalf("invalid configured model must fail before egress: %+v", aiErr)
	}

	// An unpriced real model is rejected before any paid/provider request.
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls++ }))
	t.Cleanup(server.Close)
	unpriced := New(Config{APIKey: "k", BaseURL: server.URL})
	if _, aiErr := unpriced.GenerateText(context.Background(), GenerateTextInput{
		Prompt: "x", ModelHint: "claude-unknown-future",
	}); aiErr == nil || aiErr.Class != "invalid_request" || calls != 0 {
		t.Fatalf("unpriced model must fail before provider: err=%+v calls=%d", aiErr, calls)
	}
}

func TestNormalizeModelID(t *testing.T) {
	if got, ok := NormalizeModelID("  claude-sonnet-5  "); !ok || got != "claude-sonnet-5" {
		t.Fatalf("valid model id: got=%q ok=%v", got, ok)
	}
	for _, value := range []string{
		"", "CLAUDE-SONNET-5", "claude/sonnet", "claude sonnet",
		"claude.sonnet-5", "claude_sonnet-5", "claude--sonnet-5", "claude-sonnet-5-",
		strings.Repeat("x", MaxModelIDBytes+1),
	} {
		if got, ok := NormalizeModelID(value); ok {
			t.Fatalf("invalid model id accepted: input=%q got=%q", value[:min(len(value), 40)], got)
		}
	}
}

// The success path surfaces text, usage (cache counts included), latency,
// and the resolved provider/model — with model hints honored.
func TestGenerateTextSuccessShape(t *testing.T) {
	server := fakeProvider(t, 200, successBody, 0)
	client := New(Config{APIKey: "test-key", BaseURL: server.URL, ProviderSimulated: true})
	result, aiErr := client.GenerateText(context.Background(), GenerateTextInput{
		System: "eres breve", Prompt: "saluda", ModelHint: "anthropic/claude-haiku-4-5-20251001",
		CacheSystemPrompt: true,
	})
	if aiErr != nil {
		t.Fatalf("success path: %v", aiErr)
	}
	if result.Text != "hola desde el simulador" || result.Provider != "anthropic" ||
		result.Model != "claude-haiku-4-5-20251001" || result.FinishReason != "end_turn" {
		t.Fatalf("result shape: %+v", result)
	}
	if result.Usage.InputTokens != 10 || result.Usage.OutputTokens != 5 ||
		result.Usage.TotalTokens != 18 || result.Usage.CachedInputTokens != 2 ||
		result.Usage.CacheCreationInputTokens != 1 {
		t.Fatalf("usage passthrough: %+v", result.Usage)
	}
	if !result.ProviderSimulated {
		t.Fatal("declared simulator must mark providerSimulated")
	}
	if result.LatencyMs < 0 {
		t.Fatalf("latency: %d", result.LatencyMs)
	}
}

func TestGenerateTextCallOutputLimitCanOnlyNarrowTenantCeiling(t *testing.T) {
	seen := make(chan int, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			MaxTokens int `json:"max_tokens"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode provider request: %v", err)
		}
		seen <- body.MaxTokens
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(successBody))
	}))
	t.Cleanup(server.Close)
	client := New(Config{
		APIKey: "test-key", BaseURL: server.URL, ProviderSimulated: true,
		MaxOutputTokens: 300,
	})

	if _, aiErr := client.GenerateText(t.Context(), GenerateTextInput{
		Prompt: "wide", MaxOutputUnits: 1_000,
	}); aiErr != nil {
		t.Fatalf("wide call: %v", aiErr)
	}
	if _, aiErr := client.GenerateText(t.Context(), GenerateTextInput{
		Prompt: "narrow", MaxOutputUnits: 64,
	}); aiErr != nil {
		t.Fatalf("narrow call: %v", aiErr)
	}
	if got := <-seen; got != 300 {
		t.Fatalf("call hint expanded tenant ceiling: max_tokens=%d", got)
	}
	if got := <-seen; got != 64 {
		t.Fatalf("narrower call limit was not honored: max_tokens=%d", got)
	}
}

func TestGenerateTextRejectsProviderBodyBeforeUnboundedSDKDecode(t *testing.T) {
	server := fakeProvider(t, http.StatusOK, strings.Repeat(" ", int(providerResponseMaxBytes)+1), 0)
	result, aiErr := New(Config{
		APIKey: "test-key", BaseURL: server.URL, ProviderSimulated: true,
	}).GenerateText(t.Context(), GenerateTextInput{Prompt: "bounded"})
	if result != nil || aiErr == nil || aiErr.Class != "unknown" || aiErr.Message != errProviderResponseTooLarge.Error() {
		t.Fatalf("oversized provider body was not rejected deterministically: result=%+v err=%+v", result, aiErr)
	}
}

func TestGenerateTextRecordsRecoveredProviderPanicOnce(t *testing.T) {
	var records []usage.Record
	usage.SetRecorder(func(_ context.Context, record usage.Record) error {
		records = append(records, record)
		return nil
	})
	t.Cleanup(func() { usage.SetRecorder(nil) })
	client := New(Config{
		APIKey: "test-key", BaseURL: "https://simulator.invalid", ProviderSimulated: true,
		HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			panic("transport exploded")
		})},
	})

	result, aiErr := client.GenerateText(t.Context(), GenerateTextInput{
		Prompt: "trigger", Context: CallContext{OrgID: "org-panic", WorkflowID: "wf-panic"},
	})
	if result != nil || aiErr == nil || aiErr.Class != "unknown" || !strings.Contains(aiErr.Message, "transport exploded") {
		t.Fatalf("provider panic must be classified: result=%+v err=%+v", result, aiErr)
	}
	if len(records) != 1 {
		t.Fatalf("provider panic must emit exactly one usage record: %+v", records)
	}
	record := records[0]
	if record.Mode != "fallback" || record.Provider != "anthropic" || record.Model != DefaultModel ||
		record.WorkflowID != "wf-panic" || !strings.Contains(record.AiError, "transport exploded") {
		t.Fatalf("panic usage record lost attribution: %+v", record)
	}
}

func TestCompactScrubsAndRuneBoundsProviderErrors(t *testing.T) {
	secret := "sk-ant-abcdefghijklmnopqrstuvwxyz123456"
	got := compact("provider echoed " + secret + " " + strings.Repeat("界", 600))
	if strings.Contains(got, secret) || utf8.RuneCountInString(got) > 500 || !utf8.ValidString(got) {
		t.Fatalf("provider error must be scrubbed and rune-bounded: runes=%d valid=%v value=%q",
			utf8.RuneCountInString(got), utf8.ValidString(got), got)
	}
}

// Nothing outside internal/ai may import the provider SDK — the
// chokepoint rule, enforced by walking every Go source in the module.
func TestOnlyThisPackageImportsTheProviderSDK(t *testing.T) {
	root := filepath.Join("..", "..")
	var offenders []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			name := entry.Name()
			// `output/` and `artifacts/` are gitignored scratch trees that
			// can hold entire nested checkouts; scanning them would judge
			// another worktree's source as this module's.
			if name == "vendor" || name == ".git" || name == "node_modules" ||
				name == "output" || name == "artifacts" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if !strings.Contains(string(raw), `"github.com/anthropics/anthropic-sdk-go`) {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		if !strings.HasPrefix(filepath.ToSlash(rel), "internal/ai/") {
			offenders = append(offenders, rel)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(offenders) > 0 {
		t.Fatalf("the provider SDK may only be imported by internal/ai: %v", offenders)
	}
}
