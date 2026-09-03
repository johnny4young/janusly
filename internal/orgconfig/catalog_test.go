package orgconfig

import (
	"math"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/httpcontract"
)

func TestNormalizeCatalogValues(t *testing.T) {
	tests := []struct {
		name    string
		key     string
		input   any
		want    any
		wantErr string
	}{
		{name: "boolean", key: "runs.requireSavedWorkflow", input: true, want: true},
		{name: "boolean type", key: "runs.requireSavedWorkflow", input: "true", wantErr: "must be a boolean"},
		{name: "integer normalization", key: "ai.generationCandidates", input: 3.9, want: float64(3)},
		{name: "number type", key: "ai.generationCandidates", input: "3", wantErr: "must be a finite number"},
		{name: "not a number", key: "ai.generationCandidates", input: math.NaN(), wantErr: "must be a finite number"},
		{name: "positive infinity", key: "ai.generationCandidates", input: math.Inf(1), wantErr: "must be a finite number"},
		{name: "negative infinity", key: "ai.generationCandidates", input: math.Inf(-1), wantErr: "must be a finite number"},
		{name: "minimum", key: "ai.generationCandidates", input: float64(0), wantErr: "must be >= 1"},
		{name: "maximum", key: "ai.generationCandidates", input: float64(6), wantErr: "must be <= 5"},
		{name: "AI retry maximum", key: "ai.maxRetries", input: float64(11), wantErr: "must be <= 10"},
		{name: "AI timeout maximum", key: "ai.timeoutMs", input: float64(600001), wantErr: "must be <= 600000"},
		{name: "AI prompt maximum", key: "ai.promptMaxChars", input: float64(65537), wantErr: "must be <= 65536"},
		{name: "AI rate maximum", key: "ai.rateLimitPerMin", input: float64(10001), wantErr: "must be <= 10000"},
		{name: "HTTP timeout maximum", key: "http.timeoutMs", input: float64(httpcontract.MaxTimeoutMS + 1), wantErr: "must be <= 600000"},
		{name: "HTTP body maximum", key: "http.maxResponseBytes", input: float64(httpcontract.MaxResponseBytes + 1), wantErr: "must be <= 67108864"},
		{name: "HTTP redirect maximum", key: "http.maxRedirects", input: float64(httpcontract.MaxRedirects + 1), wantErr: "must be <= 20"},
		{name: "AI model", key: "ai.anthropic.model", input: " claude-sonnet-5 ", want: "claude-sonnet-5"},
		{name: "AI model uppercase", key: "ai.anthropic.model", input: "CLAUDE-SONNET-5", wantErr: "lowercase Anthropic model id"},
		{name: "AI model oversize", key: "ai.anthropic.model", input: strings.Repeat("a", 129), wantErr: "at most 128 bytes"},
		{name: "floor before minimum", key: "ai.maxRetries", input: -0.1, wantErr: "must be >= 0"},
		{name: "fractional", key: "value.hourlyCost", input: 125.75, want: 125.75},
		{name: "trim string", key: "email.provider", input: " simulator ", want: "simulator"},
		{name: "string type", key: "email.provider", input: true, wantErr: "must be a string"},
		{name: "required string", key: "email.provider", input: "  ", wantErr: "must be a non-empty string"},
		{name: "allow empty", key: "ai.operatorGuidance", input: "  ", want: ""},
		{name: "secret shaped", key: "ai.operatorGuidance", input: "Bearer abc", wantErr: "must not contain secret-like values"},
		{name: "guidance nested secret", key: "ai.operatorGuidance", input: "database: postgres://user:pass@db.example/prod", wantErr: "must not contain secret-like values"},
		{name: "guidance byte cap", key: "ai.operatorGuidance", input: strings.Repeat("á", 4_097), wantErr: "exceeds 8 KiB cap"},
		{name: "memory kinds", key: "memory.allowedKinds", input: "run_summary, agent_episode", want: "run_summary, agent_episode"},
		{name: "unknown memory kind", key: "memory.allowedKinds", input: "run_summary, instructions", wantErr: `entry "instructions" is not one of`},
		{name: "memory retention", key: "memory.retentionDaysByKind", input: `{"run_summary":30,"runbook_fragment":36500}`, want: `{"run_summary":30,"runbook_fragment":36500}`},
		{name: "memory retention invalid json", key: "memory.retentionDaysByKind", input: `{`, wantErr: "must be valid JSON"},
		{name: "memory retention object", key: "memory.retentionDaysByKind", input: `[]`, wantErr: "must be a JSON object"},
		{name: "memory retention unknown kind", key: "memory.retentionDaysByKind", input: `{"other":1}`, wantErr: `key "other" is not one of`},
		{name: "memory retention integer", key: "memory.retentionDaysByKind", input: `{"run_summary":1.5}`, wantErr: "must be a positive integer"},
		{name: "memory retention maximum", key: "memory.retentionDaysByKind", input: `{"run_summary":366}`, wantErr: "must be <= 365"},
		{name: "embedding model", key: "memory.embeddingModel", input: " library/bge-m3:latest ", want: "library/bge-m3:latest"},
		{name: "embedding model invalid", key: "memory.embeddingModel", input: "bge m3", wantErr: "model id of at most 256 bytes"},
		{name: "embedding base URL", key: "memory.embeddingBaseUrl", input: " https://embeddings.example/v1 ", want: "https://embeddings.example/v1"},
		{name: "embedding base URL credentials", key: "memory.embeddingBaseUrl", input: "https://user:pass@embeddings.example", wantErr: "without credentials"},
		{name: "embedding base URL query", key: "memory.embeddingBaseUrl", input: "https://embeddings.example?tenant=other", wantErr: "without credentials"},
		{name: "embedding base URL scheme", key: "memory.embeddingBaseUrl", input: "file:///tmp/ollama", wantErr: "absolute HTTP(S)"},
		{name: "recovery SLA", key: "recovery.slaPolicies", input: `{"p1":30,"p4":43200}`, want: `{"p1":30,"p4":43200}`},
		{name: "recovery SLA invalid json", key: "recovery.slaPolicies", input: `{`, wantErr: "must be valid JSON"},
		{name: "recovery SLA unknown severity", key: "recovery.slaPolicies", input: `{"p0":30}`, wantErr: `key "p0" is not one of`},
		{name: "recovery SLA integer", key: "recovery.slaPolicies", input: `{"p1":1.5}`, wantErr: "must be an integer"},
		{name: "recovery SLA bounds", key: "recovery.slaPolicies", input: `{"p1":43201}`, wantErr: "must be between 1 and 43200"},
		{name: "closed enum", key: "email.provider", input: "other", wantErr: "must be one of: resend, sendgrid, simulator, noop"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			def := Get(test.key)
			if def == nil {
				t.Fatalf("missing catalog definition %q", test.key)
			}
			got, err := Normalize(def, test.input)
			if test.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantErr) {
					t.Fatalf("Normalize(%q, %#v) error = %v, want containing %q", test.key, test.input, err, test.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Normalize(%q, %#v): %v", test.key, test.input, err)
			}
			if got != test.want {
				t.Fatalf("Normalize(%q, %#v) = %#v, want %#v", test.key, test.input, got, test.want)
			}
		})
	}
}
