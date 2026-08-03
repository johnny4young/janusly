package ai

import (
	"encoding/json"
	"math/rand/v2"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/ai/failcat"
)

const validJSON = `{"dslVersion":"1.0","id":"wf-test","name":"Test flow","nodes":[{"id":"n1","type":"http","config":{"url":"https://example.com"}}],"edges":[]}`

// The reference's extraction cases, ported 1:1, plus the pilot's
// hardening family: BOM, top-level arrays, truncated output.
func TestExtractAndParseFreeJSON(t *testing.T) {
	// Reference case: clean JSON unchanged.
	if got := ExtractJSONObject(validJSON); got != validJSON {
		t.Fatalf("clean JSON must pass unchanged: %q", got)
	}
	// Reference case: markdown fences stripped.
	if value, ok := ParseJSONValue("```json\n" + validJSON + "\n```"); !ok {
		t.Fatal("fenced JSON must parse")
	} else if value.(map[string]any)["id"] != "wf-test" {
		t.Fatalf("fenced content: %+v", value)
	}
	// Reference case: outermost object sliced out of prose.
	wrapped := "Here is your workflow:\n" + validJSON + "\nHope that helps!"
	if value, ok := ParseJSONValue(wrapped); !ok || value.(map[string]any)["name"] != "Test flow" {
		t.Fatalf("prose-wrapped must slice: %v %v", value, ok)
	}

	// Hardening: BOM prefix.
	if _, ok := ParseJSONValue("\uFEFF" + validJSON); !ok {
		t.Fatal("BOM-prefixed JSON must parse")
	}
	// Hardening: top-level array.
	if value, ok := ParseJSONValue("the options are:\n[1, 2, 3]"); !ok {
		t.Fatal("top-level array must parse")
	} else if len(value.([]any)) != 3 {
		t.Fatalf("array content: %+v", value)
	}
	// Hardening: truncated object (cut mid-string) repairs.
	truncated := `{"id":"wf-1","name":"Cut mid strea`
	if value, ok := ParseJSONValue(truncated); !ok {
		t.Fatal("truncated object must repair")
	} else if value.(map[string]any)["id"] != "wf-1" {
		t.Fatalf("repaired content: %+v", value)
	}
	// Hardening: truncated nested structure (cut after a comma).
	nested := `{"nodes":[{"id":"n1"},{"id":"n2"},`
	if value, ok := ParseJSONValue(nested); !ok {
		t.Fatal("comma-truncated must repair")
	} else if nodes := value.(map[string]any)["nodes"].([]any); len(nodes) != 2 {
		t.Fatalf("repaired nodes: %+v", nodes)
	}
	// Hardening: dangling key repairs to null.
	dangling := `{"id":"wf-1","config":`
	if value, ok := ParseJSONValue(dangling); !ok {
		t.Fatal("dangling key must repair")
	} else if _, present := value.(map[string]any)["config"]; !present {
		t.Fatalf("dangling key content: %+v", value)
	}

	// Hopeless inputs: (nil, false), never a panic.
	for _, hopeless := range []string{"", "no json here", "]{[", "\x00￿", "42", `"just a string"`} {
		if _, ok := ParseJSONValue(hopeless); ok {
			t.Fatalf("hopeless input must not parse: %q", hopeless)
		}
	}
}

// The reference's property posture: ~1000 arbitrary strings never panic,
// extraction always returns a string, and every successful parse is
// genuinely an object or array.
func TestFreeJSONFuzzNeverPanics(t *testing.T) {
	rng := rand.New(rand.NewPCG(42, 7))
	alphabet := `{}[]",:\`
	pieces := []string{validJSON, "```json", "```", "prose ", "\uFEFF", "\x00", `"key":`, "null,", "[1,2"}
	for range 1000 {
		var builder strings.Builder
		for i := rng.IntN(20); i >= 0; i-- {
			if rng.IntN(3) == 0 {
				builder.WriteString(pieces[rng.IntN(len(pieces))])
			} else {
				builder.WriteByte(alphabet[rng.IntN(len(alphabet))])
			}
		}
		input := builder.String()
		extracted := ExtractJSONObject(input)
		_ = extracted // always a string by type; the point is no panic
		if value, ok := ParseJSONValue(input); ok {
			if _, err := json.Marshal(value); err != nil {
				t.Fatalf("parsed value must re-marshal: %v", err)
			}
		}
	}
}

// The shared reply catalog: every hostile model text either recovers a
// JSON object through the extract+parse ladder (Parseable) or fails
// cleanly — never a panic.
func TestFreeJSONLadderAgainstReplyCatalog(t *testing.T) {
	for _, tc := range failcat.Replies() {
		t.Run(tc.Name, func(t *testing.T) {
			extracted := ExtractJSONObject(tc.ReplyText)
			value, ok := ParseJSONValue(extracted)
			recovered := ok && value != nil
			if recovered != tc.Parseable {
				t.Fatalf("parseable=%v want %v (extracted %q)", recovered, tc.Parseable, extracted)
			}
		})
	}
}
