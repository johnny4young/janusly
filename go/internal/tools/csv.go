// Hand-rolled RFC 4180 (subset) CSV helpers, ported from the reference
// (packages/engine/src/csv.ts): comma separator, CRLF/LF terminators,
// quoted fields with "" escapes that may span commas, newlines, and CHUNK
// BOUNDARIES — the streaming state (pendingQuote / pendingCr) carries the
// ambiguity across feeds. Chunk processing is byte-wise: every structural
// character is ASCII and UTF-8 continuation bytes are >= 0x80, so a rune
// split across chunks reassembles correctly by plain byte appends.
package tools

import (
	"context"
	"fmt"
	"strings"
)

const csvBOM = "\uFEFF"

// CsvParseState carries the in-flight row/field across chunks.
type CsvParseState struct {
	row          []string
	field        strings.Builder
	inQuotes     bool
	pendingQuote bool
	pendingCr    bool
	started      bool
}

// NewCsvParseState returns a fresh streaming parser state.
func NewCsvParseState() *CsvParseState { return &CsvParseState{} }

// FeedCsvChunk feeds one chunk, returning rows completed inside it.
func (s *CsvParseState) FeedCsvChunk(input string) [][]string {
	i := 0
	if !s.started && len(s.row) == 0 && s.field.Len() == 0 && !s.inQuotes && !s.pendingQuote && !s.pendingCr {
		if strings.HasPrefix(input, csvBOM) {
			i = len(csvBOM)
		}
	}
	if len(input) > 0 {
		s.started = true
	}
	var rows [][]string

	for i < len(input) {
		if s.pendingCr {
			s.pendingCr = false
			if input[i] == '\n' {
				i++
				continue
			}
		}
		if s.pendingQuote {
			if input[i] == '"' {
				s.field.WriteByte('"')
				s.pendingQuote = false
				i++
				continue
			}
			s.pendingQuote = false
			s.inQuotes = false
			continue
		}

		ch := input[i]
		if s.inQuotes {
			if ch == '"' {
				if i+1 >= len(input) {
					s.pendingQuote = true
					i++
					continue
				}
				if input[i+1] == '"' {
					s.field.WriteByte('"')
					i += 2
					continue
				}
				s.inQuotes = false
				i++
				continue
			}
			s.field.WriteByte(ch)
			i++
			continue
		}

		switch ch {
		case '"':
			s.inQuotes = true
			i++
		case ',':
			s.row = append(s.row, s.field.String())
			s.field.Reset()
			i++
		case '\n', '\r':
			s.row = append(s.row, s.field.String())
			rows = append(rows, s.row)
			s.row = nil
			s.field.Reset()
			if ch == '\r' && i+1 < len(input) && input[i+1] == '\n' {
				i += 2
			} else {
				i++
				if ch == '\r' && i >= len(input) {
					s.pendingCr = true
				}
			}
		default:
			s.field.WriteByte(ch)
			i++
		}
	}
	return rows
}

// FinalizeCsvParse drains a partial trailing row at end-of-stream.
func (s *CsvParseState) FinalizeCsvParse() [][]string {
	if s.pendingQuote {
		s.pendingQuote = false
		s.inQuotes = false
	}
	s.pendingCr = false
	if s.field.Len() > 0 || len(s.row) > 0 {
		s.row = append(s.row, s.field.String())
		out := [][]string{s.row}
		s.row = nil
		s.field.Reset()
		return out
	}
	return nil
}

func parseCsvRows(input string) [][]string {
	state := NewCsvParseState()
	rows := state.FeedCsvChunk(input)
	return append(rows, state.FinalizeCsvParse()...)
}

// ParseCsv parses a whole CSV string. With header (default), rows become
// objects keyed by the header tokens; without, plain string arrays.
func ParseCsv(input string, hasHeader bool) any {
	rows := parseCsvRows(input)
	if len(rows) == 0 {
		return []any{}
	}
	if !hasHeader {
		out := make([]any, 0, len(rows))
		for _, row := range rows {
			cells := make([]any, len(row))
			for i, cell := range row {
				cells[i] = cell
			}
			out = append(out, cells)
		}
		return out
	}
	header := rows[0]
	out := make([]any, 0, len(rows)-1)
	for _, row := range rows[1:] {
		obj := map[string]any{}
		for i, key := range header {
			if i < len(row) {
				obj[key] = row[i]
			} else {
				obj[key] = ""
			}
		}
		out = append(out, obj)
	}
	return out
}

func formatCsvCell(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case bool:
		if v {
			return "true"
		}
		return "false"
	case float64:
		return trimFloat(v)
	default:
		return fmt.Sprint(v)
	}
}

func trimFloat(v float64) string {
	if v == float64(int64(v)) {
		return fmt.Sprintf("%d", int64(v))
	}
	return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%f", v), "0"), ".")
}

func quoteCsvField(value string) string {
	if strings.ContainsAny(value, "\",\n\r") {
		return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
	}
	return value
}

// StringifyCsv renders rows back to CSV; header implies object rows.
func StringifyCsv(rows []any, header []string) string {
	if len(rows) == 0 {
		if header != nil {
			quoted := make([]string, len(header))
			for i, h := range header {
				quoted[i] = quoteCsvField(h)
			}
			return strings.Join(quoted, ",")
		}
		return ""
	}
	var lines []string
	if header != nil {
		quoted := make([]string, len(header))
		for i, h := range header {
			quoted[i] = quoteCsvField(h)
		}
		lines = append(lines, strings.Join(quoted, ","))
		for _, raw := range rows {
			obj, _ := raw.(map[string]any)
			cells := make([]string, len(header))
			for i, key := range header {
				cells[i] = quoteCsvField(formatCsvCell(obj[key]))
			}
			lines = append(lines, strings.Join(cells, ","))
		}
		return strings.Join(lines, "\n")
	}
	for _, raw := range rows {
		arr, _ := raw.([]any)
		cells := make([]string, len(arr))
		for i, cell := range arr {
			cells[i] = quoteCsvField(formatCsvCell(cell))
		}
		lines = append(lines, strings.Join(cells, ","))
	}
	return strings.Join(lines, "\n")
}

// FilterCsv keeps object-rows matching every entry of the where map.
func FilterCsv(rows []any, where map[string]any) []any {
	if len(where) == 0 {
		return rows
	}
	out := []any{}
	for _, raw := range rows {
		obj, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		matched := true
		for key, value := range where {
			if obj[key] != value {
				matched = false
				break
			}
		}
		if matched {
			out = append(out, raw)
		}
	}
	return out
}

// csvTools are the buffered CSV registry entries; the streaming csv.fetch
// registers from the executors package (it rides the SSRF-gated HTTP
// primitive that lives there).
func csvTools() []Definition {
	return []Definition{
		{
			Name:         "csv.parse",
			Description:  "Parse a CSV string into rows. Default `hasHeader: true` returns objects keyed by header.",
			Required:     []string{"value"},
			Optional:     []string{"hasHeader"},
			Fields:       []Field{{Name: "value", Type: "string", Required: true}, {Name: "hasHeader", Type: "boolean"}},
			InputExample: map[string]any{"value": "a,b\n1,2", "hasHeader": true},
			Execute: func(_ context.Context, input map[string]any) (map[string]any, error) {
				text, ok := input["value"].(string)
				if !ok {
					return nil, fmt.Errorf("Invalid tool input for csv.parse: value: Expected string") //nolint:staticcheck // tool error shape
				}
				hasHeader := true
				if v, ok := input["hasHeader"].(bool); ok {
					hasHeader = v
				}
				return map[string]any{"rows": ParseCsv(text, hasHeader)}, nil
			},
		},
		{
			Name:        "csv.stringify",
			Description: "Serialise rows to CSV. Provide `header` for object-rows; omit for array-rows.",
			Required:    []string{"rows"},
			Optional:    []string{"header"},
			Fields: []Field{
				{Name: "rows", Type: "array", Required: true},
				{Name: "header", Type: "array"},
			},
			InputExample: map[string]any{"rows": []any{map[string]any{"a": "1", "b": "2"}}, "header": []any{"a", "b"}},
			Execute: func(_ context.Context, input map[string]any) (map[string]any, error) {
				rows, ok := input["rows"].([]any)
				if !ok {
					return nil, fmt.Errorf("Invalid tool input for csv.stringify: rows: Expected array") //nolint:staticcheck // tool error shape
				}
				var header []string
				if raw, present := input["header"]; present {
					list, ok := raw.([]any)
					if !ok {
						return nil, fmt.Errorf("Invalid tool input for csv.stringify: header: Expected array") //nolint:staticcheck // tool error shape
					}
					for _, item := range list {
						text, ok := item.(string)
						if !ok {
							return nil, fmt.Errorf("Invalid tool input for csv.stringify: header: Expected string items") //nolint:staticcheck // tool error shape
						}
						header = append(header, text)
					}
				}
				// The reference's refinement: header pairs with object rows.
				if len(rows) > 0 {
					_, rowsAreArrays := rows[0].([]any)
					if rowsAreArrays && header != nil {
						return nil, fmt.Errorf("Invalid tool input for csv.stringify: header: header is only valid with object rows") //nolint:staticcheck // tool error shape
					}
					if !rowsAreArrays && header == nil {
						return nil, fmt.Errorf("Invalid tool input for csv.stringify: header: header is required when rows are objects") //nolint:staticcheck // tool error shape
					}
				}
				return map[string]any{"value": StringifyCsv(rows, header)}, nil
			},
		},
		{
			Name:        "csv.filter",
			Description: "Filter object-rows by an exact-match `where` map (every entry must match).",
			Required:    []string{"rows", "where"},
			Fields: []Field{
				{Name: "rows", Type: "array", Required: true},
				{Name: "where", Type: "object", Required: true},
			},
			InputExample: map[string]any{"rows": []any{map[string]any{"id": "1", "status": "open"}}, "where": map[string]any{"status": "open"}},
			Execute: func(_ context.Context, input map[string]any) (map[string]any, error) {
				rows, ok := input["rows"].([]any)
				if !ok {
					return nil, fmt.Errorf("Invalid tool input for csv.filter: rows: Expected array") //nolint:staticcheck // tool error shape
				}
				where, ok := input["where"].(map[string]any)
				if !ok {
					return nil, fmt.Errorf("Invalid tool input for csv.filter: where: Expected object") //nolint:staticcheck // tool error shape
				}
				return map[string]any{"rows": FilterCsv(rows, where)}, nil
			},
		},
	}
}
