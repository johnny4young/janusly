package orgconfig

import (
	"strings"
	"testing"
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
		{name: "minimum", key: "ai.generationCandidates", input: float64(0), wantErr: "must be >= 1"},
		{name: "maximum", key: "ai.generationCandidates", input: float64(6), wantErr: "must be <= 5"},
		{name: "fractional", key: "value.hourlyCost", input: 125.75, want: 125.75},
		{name: "trim string", key: "ai.provider", input: " anthropic ", want: "anthropic"},
		{name: "string type", key: "ai.provider", input: true, wantErr: "must be a string"},
		{name: "required string", key: "ai.provider", input: "  ", wantErr: "must be a non-empty string"},
		{name: "allow empty", key: "ai.operatorGuidance", input: "  ", want: ""},
		{name: "secret shaped", key: "ai.operatorGuidance", input: "Bearer abc", wantErr: "must not contain secret-like values"},
		{name: "closed enum", key: "ai.provider", input: "other", wantErr: "must be one of: openai, anthropic"},
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
