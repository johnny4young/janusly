package ai

import (
	"encoding/json"
	"reflect"
	"testing"
)

func FuzzParseJSONValueBounded(f *testing.F) {
	for _, seed := range []string{validJSON, "", "42", "null", "[]", "{}", "\uFEFF" + validJSON, "```json\n" + validJSON + "\n```", `{"config":`, `{"nodes":[{"id":"a"},`, "\x00[]", `{"es":"intención","unicode":"😀"}`, `{"value":1e999}`, `{"value":"\\\""}`} {
		for _, limit := range []int32{-1, 0, int32(len(seed)), int32(len(seed) - 1), 256 * 1024} {
			f.Add(seed, limit)
		}
	}
	f.Fuzz(func(t *testing.T, text string, requestedLimit int32) {
		const ceiling = 256 * 1024
		limit := min(int(requestedLimit), ceiling)
		value, ok := ParseJSONValueBounded(text, limit)
		if limit <= 0 || len(text) > limit {
			if ok || value != nil {
				t.Fatal("byte limit must reject before extraction or repair")
			}
			return
		}
		again, againOK := ParseJSONValueBounded(text, limit)
		if ok != againOK || !reflect.DeepEqual(value, again) {
			t.Fatal("bounded parsing must be deterministic")
		}
		if !ok {
			if value != nil {
				t.Fatal("failed parsing returned a value")
			}
			return
		}
		switch value.(type) {
		case map[string]any, []any:
		default:
			t.Fatalf("unexpected successful value %T", value)
		}
		if _, err := json.Marshal(value); err != nil {
			t.Fatalf("parsed output cannot be serialized: %v", err)
		}
	})
}
