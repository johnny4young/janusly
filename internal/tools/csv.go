// Hand-rolled RFC 4180 (subset) CSV helpers, implements the contract
// (the source contract): comma separator, CRLF/LF terminators,
// quoted fields with "" escapes that may span commas, newlines, and CHUNK
// BOUNDARIES — the streaming state (pendingQuote / pendingCr) carries the
// ambiguity across feeds. Chunk processing is byte-wise: every structural
// character is ASCII and UTF-8 continuation bytes are >= 0x80, so a rune
// split across chunks reassembles correctly by plain byte appends.
package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"unicode/utf8"
)

const csvBOM = "\uFEFF"

const (
	csvBufferedMaxBytes = 2 << 20
	csvMaxRows          = 10_000
	csvMaxColumns       = 500
	csvMaxHeaderRunes   = 120
	csvMaxCellBytes     = 256 << 10
)

// CsvParseState carries the in-flight row/field across chunks.
type CsvParseState struct {
	row          []string
	field        strings.Builder
	inQuotes     bool
	pendingQuote bool
	afterQuote   bool
	pendingCr    bool
	fieldStarted bool
	started      bool
	err          string
}

// NewCsvParseState returns a fresh streaming parser state.
func NewCsvParseState() *CsvParseState { return &CsvParseState{} }

// FeedCsvChunk feeds one chunk, returning rows completed inside it.
func (s *CsvParseState) FeedCsvChunk(input string) [][]string {
	if s.err != "" {
		return nil
	}
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
				if s.field.Len() >= csvMaxCellBytes {
					s.err = "CSV field exceeds the size bound"
					return rows
				}
				s.field.WriteByte('"')
				s.pendingQuote = false
				i++
				continue
			}
			s.pendingQuote = false
			s.inQuotes = false
			s.afterQuote = true
			continue
		}
		if s.afterQuote {
			switch input[i] {
			case ',':
				if len(s.row)+1 >= csvMaxColumns {
					s.err = "CSV row exceeds the column bound"
					return rows
				}
				s.row = append(s.row, s.field.String())
				s.field.Reset()
				s.fieldStarted = false
				s.afterQuote = false
				i++
				continue
			case '\n', '\r':
				s.row = append(s.row, s.field.String())
				rows = append(rows, s.row)
				s.row = nil
				s.field.Reset()
				s.fieldStarted = false
				s.afterQuote = false
				if input[i] == '\r' && i+1 < len(input) && input[i+1] == '\n' {
					i += 2
				} else {
					i++
					if input[i-1] == '\r' && i >= len(input) {
						s.pendingCr = true
					}
				}
				continue
			default:
				s.err = "CSV contains characters after a closing quote"
				return rows
			}
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
				s.afterQuote = true
				i++
				continue
			}
			if s.field.Len() >= csvMaxCellBytes {
				s.err = "CSV field exceeds the size bound"
				return rows
			}
			s.field.WriteByte(ch)
			s.fieldStarted = true
			i++
			continue
		}

		switch ch {
		case '"':
			if s.field.Len() != 0 || s.fieldStarted {
				s.err = "CSV quote must begin a field"
				return rows
			}
			s.inQuotes = true
			s.fieldStarted = true
			i++
		case ',':
			if len(s.row)+1 >= csvMaxColumns {
				s.err = "CSV row exceeds the column bound"
				return rows
			}
			s.row = append(s.row, s.field.String())
			s.field.Reset()
			s.fieldStarted = false
			i++
		case '\n', '\r':
			s.row = append(s.row, s.field.String())
			rows = append(rows, s.row)
			s.row = nil
			s.field.Reset()
			s.fieldStarted = false
			if ch == '\r' && i+1 < len(input) && input[i+1] == '\n' {
				i += 2
			} else {
				i++
				if ch == '\r' && i >= len(input) {
					s.pendingCr = true
				}
			}
		default:
			if s.field.Len() >= csvMaxCellBytes {
				s.err = "CSV field exceeds the size bound"
				return rows
			}
			s.field.WriteByte(ch)
			s.fieldStarted = true
			i++
		}
	}
	return rows
}

// FinalizeCsvParse drains a partial trailing row at end-of-stream.
func (s *CsvParseState) FinalizeCsvParse() [][]string {
	if s.err != "" {
		return nil
	}
	if s.pendingQuote {
		s.pendingQuote = false
		s.inQuotes = false
		s.afterQuote = true
	}
	if s.inQuotes {
		s.err = "CSV contains an unterminated quoted field"
		return nil
	}
	s.pendingCr = false
	if s.fieldStarted || s.field.Len() > 0 || len(s.row) > 0 {
		s.row = append(s.row, s.field.String())
		out := [][]string{s.row}
		s.row = nil
		s.field.Reset()
		return out
	}
	return nil
}

// Error reports a bounded grammar failure discovered while streaming.
func (s *CsvParseState) Error() string { return s.err }

func parseCsvRowsStrict(input string) ([][]string, error) {
	if len(input) > csvBufferedMaxBytes {
		return nil, fmt.Errorf("CSV text exceeds %d bytes", csvBufferedMaxBytes)
	}
	state := NewCsvParseState()
	rows := make([][]string, 0)
	for offset := 0; offset < len(input); {
		end := min(offset+4*1024, len(input))
		rows = append(rows, state.FeedCsvChunk(input[offset:end])...)
		if state.Error() != "" {
			return nil, fmt.Errorf("%s", state.Error())
		}
		if len(rows) > csvMaxRows+1 {
			return nil, fmt.Errorf("CSV exceeds %d data rows", csvMaxRows)
		}
		offset = end
	}
	rows = append(rows, state.FinalizeCsvParse()...)
	if state.Error() != "" {
		return nil, fmt.Errorf("%s", state.Error())
	}
	return rows, nil
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
	return shapeCsvRows(rows, hasHeader)
}

func shapeCsvRows(rows [][]string, hasHeader bool) any {
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

func validateCSVHeader(header []string) error {
	if len(header) == 0 || len(header) > csvMaxColumns {
		return fmt.Errorf("CSV header must contain 1..%d columns", csvMaxColumns)
	}
	seen := make(map[string]bool, len(header))
	for _, name := range header {
		if name == "" || utf8.RuneCountInString(name) > csvMaxHeaderRunes || strings.ContainsAny(name, "\r\n") {
			return fmt.Errorf("CSV header names must be non-empty, single-line, and at most %d characters", csvMaxHeaderRunes)
		}
		if seen[name] {
			return fmt.Errorf("CSV header names must be unique")
		}
		seen[name] = true
	}
	return nil
}

// ValidateCSVHeader exposes the shared header contract to the streaming
// executor without exporting the parser's mutable state.
func ValidateCSVHeader(header []string) error { return validateCSVHeader(header) }

func validateParsedCSVRows(rows [][]string, hasHeader, headerKnown bool) error {
	maximumRows := csvMaxRows
	if (hasHeader && headerKnown) || !headerKnown {
		maximumRows++
	}
	if len(rows) > maximumRows {
		return fmt.Errorf("CSV exceeds %d data rows", csvMaxRows)
	}
	if len(rows) == 0 {
		return nil
	}
	width := len(rows[0])
	if width == 0 || width > csvMaxColumns {
		return fmt.Errorf("CSV rows must contain 1..%d columns", csvMaxColumns)
	}
	for index, row := range rows {
		if len(row) != width {
			return fmt.Errorf("CSV row %d has %d columns; expected %d", index+1, len(row), width)
		}
	}
	if hasHeader && headerKnown {
		return validateCSVHeader(rows[0])
	}
	return nil
}

func validateCSVParseInput(input map[string]any, options InputValidationOptions) error {
	raw, present := input["value"]
	if !present || isDeferredWholeTemplate(raw, options) {
		return nil
	}
	text := raw.(string)
	if len(text) > csvBufferedMaxBytes {
		return fmt.Errorf("CSV text exceeds %d bytes", csvBufferedMaxBytes)
	}
	rows, err := parseCsvRowsStrict(text)
	if err != nil {
		return err
	}
	hasHeader := true
	headerKnown := true
	if rawHeader, headerPresent := input["hasHeader"]; headerPresent {
		if isDeferredWholeTemplate(rawHeader, options) {
			headerKnown = false
		} else {
			hasHeader = rawHeader.(bool)
		}
	}
	return validateParsedCSVRows(rows, hasHeader, headerKnown)
}

func validateCSVCell(value any) bool {
	switch typed := value.(type) {
	case nil, bool:
		return true
	case string:
		return len(typed) <= csvMaxCellBytes
	default:
		return validJSONNumber(typed)
	}
}

func normalizeCSVHeader(raw any) ([]string, error) {
	items, ok := arrayItems(raw)
	if !ok {
		return nil, fmt.Errorf("header must be an array")
	}
	header := make([]string, len(items))
	for index, item := range items {
		value, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("header entries must be strings")
		}
		header[index] = value
	}
	if err := validateCSVHeader(header); err != nil {
		return nil, err
	}
	return header, nil
}

func normalizeCSVRows(raw any) ([]any, string, error) {
	rows, ok := arrayItems(raw)
	if !ok || len(rows) > csvMaxRows {
		return nil, "", fmt.Errorf("rows must contain at most %d entries", csvMaxRows)
	}
	serialized, err := json.Marshal(raw)
	if err != nil || len(serialized) > csvBufferedMaxBytes {
		return nil, "", fmt.Errorf("rows exceed the %d byte bound", csvBufferedMaxBytes)
	}
	normalized := make([]any, 0, len(rows))
	kind := ""
	for _, rawRow := range rows {
		if row, ok := rawRow.(map[string]any); ok {
			if kind == "array" {
				return nil, "", fmt.Errorf("rows must not mix arrays and objects")
			}
			kind = "object"
			if len(row) > csvMaxColumns {
				return nil, "", fmt.Errorf("object rows support at most %d columns", csvMaxColumns)
			}
			keys := make([]string, 0, len(row))
			for key, value := range row {
				keys = append(keys, key)
				if !validateCSVCell(value) {
					return nil, "", fmt.Errorf("CSV cells must be bounded JSON scalar values")
				}
			}
			if len(keys) > 0 {
				if err := validateCSVHeader(keys); err != nil {
					return nil, "", err
				}
			}
			normalized = append(normalized, row)
			continue
		}
		row, ok := arrayItems(rawRow)
		if !ok || len(row) == 0 || len(row) > csvMaxColumns {
			return nil, "", fmt.Errorf("array rows must contain 1..%d cells", csvMaxColumns)
		}
		if kind == "object" {
			return nil, "", fmt.Errorf("rows must not mix arrays and objects")
		}
		kind = "array"
		for _, value := range row {
			if !validateCSVCell(value) {
				return nil, "", fmt.Errorf("CSV cells must be bounded JSON scalar values")
			}
		}
		normalized = append(normalized, row)
	}
	return normalized, kind, nil
}

func validateCSVStringifyInput(input map[string]any, options InputValidationOptions) error {
	rowsRaw, rowsPresent := input["rows"]
	rowsDeferred := rowsPresent && isDeferredWholeTemplate(rowsRaw, options)
	var rows []any
	kind := ""
	if rowsPresent && !rowsDeferred {
		var err error
		rows, kind, err = normalizeCSVRows(rowsRaw)
		if err != nil {
			return err
		}
	}
	headerRaw, headerPresent := input["header"]
	headerDeferred := headerPresent && isDeferredWholeTemplate(headerRaw, options)
	var header []string
	if headerPresent && !headerDeferred {
		var err error
		header, err = normalizeCSVHeader(headerRaw)
		if err != nil {
			return err
		}
	}
	if !rowsDeferred {
		switch kind {
		case "array":
			if headerPresent {
				return fmt.Errorf("header is only valid with object rows")
			}
		case "object":
			if !headerPresent {
				if options.RequireAll {
					return fmt.Errorf("header is required when rows are objects")
				}
				return nil
			}
			if !headerDeferred {
				known := make(map[string]bool, len(header))
				for _, name := range header {
					known[name] = true
				}
				for _, rawRow := range rows {
					for name := range rawRow.(map[string]any) {
						if !known[name] {
							return fmt.Errorf("object row contains column %s outside the header", name)
						}
					}
				}
			}
		}
		if !headerDeferred {
			if output := StringifyCsv(rows, header); len(output) > csvBufferedMaxBytes {
				return fmt.Errorf("CSV output exceeds %d bytes", csvBufferedMaxBytes)
			}
		}
	}
	return nil
}

func validateCSVFilterInput(input map[string]any, options InputValidationOptions) error {
	if raw, present := input["rows"]; present && !isDeferredWholeTemplate(raw, options) {
		_, kind, err := normalizeCSVRows(raw)
		if err != nil {
			return err
		}
		if kind != "" && kind != "object" {
			return fmt.Errorf("rows must contain only objects")
		}
	}
	if raw, present := input["where"]; present && !isDeferredWholeTemplate(raw, options) {
		where := raw.(map[string]any)
		if len(where) > csvMaxColumns {
			return fmt.Errorf("where supports at most %d entries", csvMaxColumns)
		}
		if err := validateBoundedJSONValue(where, csvBufferedMaxBytes, true); err != nil {
			return fmt.Errorf("where: %w", err)
		}
		for key, value := range where {
			if key == "" || utf8.RuneCountInString(key) > csvMaxHeaderRunes || !validateCSVCell(value) {
				return fmt.Errorf("where must use bounded column names and JSON scalar values")
			}
		}
	}
	return nil
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
			if !reflect.DeepEqual(obj[key], value) {
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
			Validate:     validateCSVParseInput,
			Execute: func(_ context.Context, input map[string]any) (map[string]any, error) {
				text, ok := input["value"].(string)
				if !ok {
					return nil, fmt.Errorf("Invalid tool input for csv.parse: value: Expected string") //nolint:staticcheck // tool error shape
				}
				hasHeader := true
				if v, ok := input["hasHeader"].(bool); ok {
					hasHeader = v
				}
				rows, err := parseCsvRowsStrict(text)
				if err != nil {
					return nil, fmt.Errorf("Invalid tool input for csv.parse: %w", err) //nolint:staticcheck // tool error shape
				}
				return map[string]any{"rows": shapeCsvRows(rows, hasHeader)}, nil
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
			Validate:     validateCSVStringifyInput,
			Execute: func(_ context.Context, input map[string]any) (map[string]any, error) {
				rows, _, err := normalizeCSVRows(input["rows"])
				if err != nil {
					return nil, fmt.Errorf("Invalid tool input for csv.stringify: rows: Expected array") //nolint:staticcheck // tool error shape
				}
				var header []string
				if raw, present := input["header"]; present {
					header, err = normalizeCSVHeader(raw)
					if err != nil {
						return nil, fmt.Errorf("Invalid tool input for csv.stringify: %w", err) //nolint:staticcheck // tool error shape
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
			Validate:     validateCSVFilterInput,
			Execute: func(_ context.Context, input map[string]any) (map[string]any, error) {
				rows, ok := arrayItems(input["rows"])
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
