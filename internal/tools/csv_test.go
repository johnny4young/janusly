package tools

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

// Grammar cases implements the contract's csv tests: quotes, escapes,
// embedded newlines, CRLF, BOM, trailing rows.
func TestParseCsvGrammar(t *testing.T) {
	rows := ParseCsv("a,b\n1,\"x,y\"\n2,\"say \"\"hi\"\"\"", true).([]any)
	if len(rows) != 2 {
		t.Fatalf("rows: %+v", rows)
	}
	first := rows[0].(map[string]any)
	second := rows[1].(map[string]any)
	if first["b"] != "x,y" || second["b"] != `say "hi"` {
		t.Fatalf("quoting: %+v %+v", first, second)
	}

	// Quoted fields may span newlines; CRLF is one terminator; BOM strips.
	multi := ParseCsv("\uFEFF"+"name,note\r\nada,\"line1\nline2\"\r\n", true).([]any)
	if multi[0].(map[string]any)["note"] != "line1\nline2" {
		t.Fatalf("embedded newline: %+v", multi)
	}

	// No header → arrays; missing trailing newline keeps the last row.
	raw := ParseCsv("1,2\n3,4", false).([]any)
	if len(raw) != 2 || !reflect.DeepEqual(raw[1], []any{"3", "4"}) {
		t.Fatalf("headerless: %+v", raw)
	}

	// Short rows pad with "" against the header.
	padded := ParseCsv("a,b,c\n1,2", true).([]any)
	if padded[0].(map[string]any)["c"] != "" {
		t.Fatalf("padding: %+v", padded)
	}
}

// The streaming state must survive hostile chunk boundaries: a "" escape
// split across chunks and a CRLF split across chunks.
func TestFeedCsvChunkBoundaries(t *testing.T) {
	full := "a,b\r\n\"say \"\"hi\"\"\",2\r\n"
	want := parseCsvRows(full)
	for cut := 1; cut < len(full); cut++ {
		state := NewCsvParseState()
		rows := state.FeedCsvChunk(full[:cut])
		rows = append(rows, state.FeedCsvChunk(full[cut:])...)
		rows = append(rows, state.FinalizeCsvParse()...)
		if !reflect.DeepEqual(rows, want) {
			t.Fatalf("cut at %d: got %+v want %+v", cut, rows, want)
		}
	}
}

func TestStringifyRoundTripAndValidation(t *testing.T) {
	rows := []any{map[string]any{"a": "x,y", "b": `q"z`}}
	csv := StringifyCsv(rows, []string{"a", "b"})
	back := ParseCsv(csv, true).([]any)
	if !reflect.DeepEqual(back[0], rows[0]) {
		t.Fatalf("round trip: %q → %+v", csv, back)
	}

	registry := NewRegistry()
	// Object rows without header → the contract's refinement error.
	_, err := registry.Execute(context.Background(), "csv.stringify",
		map[string]any{"rows": []any{map[string]any{"a": "1"}}})
	if err == nil || !strings.Contains(err.Error(), "header is required when rows are objects") {
		t.Fatalf("refinement: %v", err)
	}
	// Array rows with header → invalid too.
	_, err = registry.Execute(context.Background(), "csv.stringify",
		map[string]any{"rows": []any{[]any{"1"}}, "header": []any{"a"}})
	if err == nil || !strings.Contains(err.Error(), "header is only valid with object rows") {
		t.Fatalf("refinement 2: %v", err)
	}

	out, err := registry.Execute(context.Background(), "csv.filter", map[string]any{
		"rows":  []any{map[string]any{"s": "open"}, map[string]any{"s": "done"}},
		"where": map[string]any{"s": "open"},
	})
	if err != nil || len(out["rows"].([]any)) != 1 {
		t.Fatalf("filter: %v %+v", err, out)
	}
}
