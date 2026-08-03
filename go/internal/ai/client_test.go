package ai

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/johnny4young/janusly/go/internal/ai/failcat"
)

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
		result.Usage.TotalTokens != 15 || result.Usage.CachedInputTokens != 2 ||
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
			if name == "vendor" || name == ".git" || name == "node_modules" {
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
