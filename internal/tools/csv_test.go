package tools

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

func parseCSVThroughRegistry(t *testing.T, input string, hasHeader bool) []any {
	t.Helper()
	result, err := NewRegistry().Execute(context.Background(), "csv.parse", map[string]any{
		"value": input, "hasHeader": hasHeader,
	})
	if err != nil {
		t.Fatalf("parse CSV through registry: %v", err)
	}
	return result["rows"].([]any)
}

// Grammar cases implements the contract's csv tests: quotes, escapes,
// embedded newlines, CRLF, BOM, trailing rows.
func TestParseCsvGrammar(t *testing.T) {
	rows := parseCSVThroughRegistry(t, "a,b\n1,\"x,y\"\n2,\"say \"\"hi\"\"\"", true)
	if len(rows) != 2 {
		t.Fatalf("rows: %+v", rows)
	}
	first := rows[0].(map[string]any)
	second := rows[1].(map[string]any)
	if first["b"] != "x,y" || second["b"] != `say "hi"` {
		t.Fatalf("quoting: %+v %+v", first, second)
	}

	// Quoted fields may span newlines; CRLF is one terminator; BOM strips.
	multi := parseCSVThroughRegistry(t, "\uFEFF"+"name,note\r\nada,\"line1\nline2\"\r\n", true)
	if multi[0].(map[string]any)["note"] != "line1\nline2" {
		t.Fatalf("embedded newline: %+v", multi)
	}

	// No header → arrays; missing trailing newline keeps the last row.
	raw := parseCSVThroughRegistry(t, "1,2\n3,4", false)
	if len(raw) != 2 || !reflect.DeepEqual(raw[1], []any{"3", "4"}) {
		t.Fatalf("headerless: %+v", raw)
	}

	// The actual tool rejects inconsistent width instead of padding an
	// apparently valid object with invented empty cells.
	_, err := NewRegistry().Execute(context.Background(), "csv.parse", map[string]any{
		"value": "a,b,c\n1,2", "hasHeader": true,
	})
	if err == nil || !strings.Contains(err.Error(), "row 2 has 2 columns; expected 3") {
		t.Fatalf("short CSV row was accepted: %v", err)
	}
}

// The streaming state must survive hostile chunk boundaries: a "" escape
// split across chunks and a CRLF split across chunks.
func TestFeedCsvChunkBoundaries(t *testing.T) {
	full := "a,b\r\n\"say \"\"hi\"\"\",2\r\n"
	want, err := parseCsvRowsStrict(full)
	if err != nil {
		t.Fatalf("parse expected rows: %v", err)
	}
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

func TestCSVStrictGrammarRejectsAmbiguousInput(t *testing.T) {
	registry := NewRegistry()
	for name, value := range map[string]string{
		"unterminated quote": "a,b\n1,\"open",
		"quote inside field": "a,b\nva\"lue,x",
		"text after quote":   "a,b\n\"value\"suffix,x",
		"inconsistent width": "a,b\n1",
		"duplicate header":   "a,a\n1,2",
		"excess columns":     strings.Repeat(",", csvMaxColumns),
		"excess rows":        strings.Repeat("x\n", csvMaxRows+2),
	} {
		t.Run(name, func(t *testing.T) {
			err := registry.ValidateInput("csv.parse", map[string]any{"value": value})
			if err == nil {
				t.Fatalf("ambiguous CSV was accepted: %q", value)
			}
		})
	}

	rows, err := parseCsvRowsStrict(`""`)
	if err != nil || !reflect.DeepEqual(rows, [][]string{{""}}) {
		t.Fatalf("quoted empty cell must remain a real cell: rows=%#v err=%v", rows, err)
	}
}

func TestStringifyRoundTripAndValidation(t *testing.T) {
	rows := []any{map[string]any{"a": "x,y", "b": `q"z`}}
	csv := StringifyCsv(rows, []string{"a", "b"})
	back := parseCSVThroughRegistry(t, csv, true)
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

func TestCSVStringifyAndFilterUseBoundedUniformRows(t *testing.T) {
	registry := NewRegistry()
	if err := registry.ValidatePartialInput("csv.stringify", map[string]any{
		"rows": []map[string]any{{"a": "1"}},
	}); err != nil {
		t.Fatalf("an incomplete proposal may still be missing its object header: %v", err)
	}
	if err := registry.ValidateInput("csv.stringify", map[string]any{
		"rows": [][]any{{"a", 1}, {"b", 2}},
	}); err != nil {
		t.Fatalf("typed arrays should validate: %v", err)
	}
	out, err := registry.Execute(context.Background(), "csv.stringify", map[string]any{
		"rows": [][]any{{"a", 1}, {"b", 2}},
	})
	if err != nil || out["value"] != "a,1\nb,2" {
		t.Fatalf("typed arrays must execute consistently: out=%+v err=%v", out, err)
	}

	tests := []struct {
		name    string
		tool    string
		input   map[string]any
		message string
	}{
		{name: "mixed rows", tool: "csv.stringify", input: map[string]any{"rows": []any{[]any{"a"}, map[string]any{"a": "b"}}}, message: "must not mix"},
		{name: "array header", tool: "csv.stringify", input: map[string]any{"rows": []any{[]any{"a"}}, "header": []any{"a"}}, message: "only valid with object"},
		{name: "missing object header", tool: "csv.stringify", input: map[string]any{"rows": []any{map[string]any{"a": "1"}}}, message: "header is required"},
		{name: "unknown object column", tool: "csv.stringify", input: map[string]any{"rows": []any{map[string]any{"b": "1"}}, "header": []any{"a"}}, message: "outside the header"},
		{name: "nested cell", tool: "csv.stringify", input: map[string]any{"rows": []any{[]any{map[string]any{"a": 1}}}}, message: "JSON scalar"},
		{name: "array filter rows", tool: "csv.filter", input: map[string]any{"rows": []any{[]any{"open"}}, "where": map[string]any{"status": "open"}}, message: "only objects"},
		{name: "nested filter value", tool: "csv.filter", input: map[string]any{"rows": []any{map[string]any{"status": "open"}}, "where": map[string]any{"status": map[string]any{"eq": "open"}}}, message: "JSON scalar"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := registry.ValidateInput(test.tool, test.input)
			if err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("expected %q rejection, got %v", test.message, err)
			}
		})
	}

	// The pure helper also remains panic-free if called by future internal
	// code with composite values; registry users reject this shape earlier.
	filtered := FilterCsv([]any{map[string]any{"status": map[string]any{"value": "open"}}},
		map[string]any{"status": map[string]any{"value": "open"}})
	if len(filtered) != 1 {
		t.Fatalf("deep comparison should be deterministic: %+v", filtered)
	}
}
