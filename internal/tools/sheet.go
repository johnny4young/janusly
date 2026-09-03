// sheet.append — the report-to-spreadsheet sink. Appends rows to a named
// per-org CSV object in the configured object store: the first append
// creates the sheet (header from `header` or, for object rows, sorted
// keys), later appends align to the SHEET'S existing header so columns
// stay stable no matter what shape later rows arrive in.
//
// Appends hold a tenant/sheet advisory lock across object read+write, so every
// Janusly replica sharing PostgreSQL observes one serialized append stream.
// Sheets are bounded at 8 MiB.
package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/johnny4young/janusly/internal/objectstore"
)

const (
	sheetMaxBytes       = 8 << 20
	sheetMaxRowsPerCall = 1000
	sheetMaxColumns     = 200
	sheetMaxHeaderRunes = 120
	sheetNameMaxRunes   = 128
	sheetNameMaxBytes   = 512
	sheetInputMaxBytes  = 4 << 20
	sheetCellMaxBytes   = 64 << 10
)

func validateSheetName(name string) error {
	if name == "" || name != strings.TrimSpace(name) || name == "." || name == ".." ||
		strings.Contains(name, "..") || strings.ContainsAny(name, `/\\`) ||
		len(name) > sheetNameMaxBytes || utf8.RuneCountInString(name) > sheetNameMaxRunes {
		return fmt.Errorf("name must be a safe base name of at most %d characters", sheetNameMaxRunes)
	}
	for _, character := range name {
		if unicode.IsControl(character) {
			return fmt.Errorf("name must not contain control characters")
		}
	}
	return nil
}

func validateSheetCell(value any) bool {
	switch typed := value.(type) {
	case nil, bool:
		return true
	case string:
		return len(typed) <= sheetCellMaxBytes
	default:
		return validJSONNumber(typed)
	}
}

func validateSheetRows(raw any) ([]any, error) {
	rows, ok := arrayItems(raw)
	if !ok || len(rows) == 0 || len(rows) > sheetMaxRowsPerCall {
		return nil, fmt.Errorf("rows must contain 1..%d arrays or objects", sheetMaxRowsPerCall)
	}
	serialized, err := json.Marshal(raw)
	if err != nil || len(serialized) > sheetInputMaxBytes {
		return nil, fmt.Errorf("rows exceed the %d byte input bound", sheetInputMaxBytes)
	}
	for _, rawRow := range rows {
		var cells []any
		switch row := rawRow.(type) {
		case map[string]any:
			if len(row) == 0 || len(row) > sheetMaxColumns {
				return nil, fmt.Errorf("object rows must contain 1..%d columns", sheetMaxColumns)
			}
			header := make([]string, 0, len(row))
			for key, value := range row {
				header = append(header, key)
				cells = append(cells, value)
			}
			if message := validateSheetHeader(header); message != "" {
				return nil, fmt.Errorf("object row keys are invalid: %s", message)
			}
		default:
			var rowOK bool
			cells, rowOK = arrayItems(rawRow)
			if !rowOK || len(cells) == 0 || len(cells) > sheetMaxColumns {
				return nil, fmt.Errorf("array rows must contain 1..%d cells", sheetMaxColumns)
			}
		}
		for _, cell := range cells {
			if !validateSheetCell(cell) {
				return nil, fmt.Errorf("cells must be JSON scalar values bounded to %d bytes", sheetCellMaxBytes)
			}
		}
	}
	return rows, nil
}

func validateSheetInput(input map[string]any, options InputValidationOptions) error {
	if raw, present := input["name"]; present && !isDeferredWholeTemplate(raw, options) {
		name, ok := raw.(string)
		if !ok {
			return fmt.Errorf("name must be a string")
		}
		if err := validateSheetName(name); err != nil {
			return err
		}
	}
	rowsRaw, rowsPresent := input["rows"]
	rowsDeferred := rowsPresent && isDeferredWholeTemplate(rowsRaw, options)
	var rows []any
	if rowsPresent && !rowsDeferred {
		var err error
		rows, err = validateSheetRows(rowsRaw)
		if err != nil {
			return err
		}
	}
	headerRaw, headerPresent := input["header"]
	headerDeferred := headerPresent && isDeferredWholeTemplate(headerRaw, options)
	var header []string
	if headerPresent && !headerDeferred {
		var message string
		header, message = normalizeSheetHeader(headerRaw, true)
		if message != "" {
			return errors.New(message)
		}
	}
	if len(rows) > 0 && len(header) > 0 {
		if _, message := normalizeSheetRows(rows, header); message != "" {
			return errors.New(message)
		}
	}
	return nil
}

// sheetObjectKey namespaces the sheet under its tenant; the name is
// WORKFLOW-AUTHOR input feeding an object key, so it is reduced to its
// last path segment with dot-segments refused, exactly like pdf.generate.
func sheetObjectKey(orgID, name string) string {
	name = strings.TrimSpace(name)
	if slash := strings.LastIndexAny(name, "/\\"); slash >= 0 {
		name = name[slash+1:]
	}
	name = strings.ReplaceAll(name, "..", "")
	if name == "" || name == ".csv" {
		return ""
	}
	if !strings.HasSuffix(strings.ToLower(name), ".csv") {
		name += ".csv"
	}
	return "orgs/" + orgID + "/sheets/" + name
}

func normalizeSheetHeader(raw any, present bool) ([]string, string) {
	if !present {
		return nil, ""
	}
	cells, ok := arrayItems(raw)
	if !ok || len(cells) == 0 || len(cells) > sheetMaxColumns {
		return nil, "sheet.append header must contain 1 to 200 strings"
	}
	header := make([]string, 0, len(cells))
	for _, cell := range cells {
		text, ok := cell.(string)
		if !ok {
			return nil, "sheet.append header must contain only strings"
		}
		if text != strings.TrimSpace(text) {
			return nil, "sheet.append header names must be trimmed"
		}
		header = append(header, text)
	}
	if errMessage := validateSheetHeader(header); errMessage != "" {
		return nil, errMessage
	}
	return header, ""
}

func validateSheetHeader(header []string) string {
	if len(header) == 0 || len(header) > sheetMaxColumns {
		return "sheet.append header must contain 1 to 200 columns"
	}
	seen := make(map[string]bool, len(header))
	for _, name := range header {
		if name == "" || name != strings.TrimSpace(name) || utf8.RuneCountInString(name) > sheetMaxHeaderRunes || strings.ContainsAny(name, "\r\n") {
			return "sheet.append header names must be non-empty, single-line, and at most 120 characters"
		}
		if seen[name] {
			return "sheet.append header names must be unique"
		}
		seen[name] = true
	}
	return ""
}

func sheetSafeCell(value any) any {
	text, ok := value.(string)
	if !ok {
		return value
	}
	formulaCandidate := strings.TrimLeft(text, " \t\r")
	if formulaCandidate == "" {
		return text
	}
	switch formulaCandidate[0] {
	case '=', '+', '-', '@':
		// Leading apostrophe is the spreadsheet convention for literal text.
		// Keep the original whitespace/content after it for round-trip clarity.
		return "'" + text
	default:
		return text
	}
}

// normalizeSheetRows makes every row compatible with the effective sheet
// shape. With a header, object rows align by key and array rows align by
// index; without a header, every row must be an equally-wide array.
func normalizeSheetRows(rows []any, header []string) ([]any, string) {
	normalized := make([]any, 0, len(rows))
	if header != nil {
		knownColumns := make(map[string]bool, len(header))
		for _, name := range header {
			knownColumns[name] = true
		}
		for _, raw := range rows {
			if row, ok := raw.(map[string]any); ok {
				for name := range row {
					if !knownColumns[name] {
						return nil, "sheet.append object row contains columns outside the sheet header"
					}
				}
				copyRow := make(map[string]any, len(header))
				for _, name := range header {
					copyRow[name] = sheetSafeCell(row[name])
				}
				normalized = append(normalized, copyRow)
				continue
			}
			if row, ok := arrayItems(raw); ok {
				if len(row) > len(header) {
					return nil, "sheet.append row has more cells than the sheet header"
				}
				copyRow := make(map[string]any, len(header))
				for index, name := range header {
					if index < len(row) {
						copyRow[name] = sheetSafeCell(row[index])
					}
				}
				normalized = append(normalized, copyRow)
				continue
			}
			return nil, "sheet.append rows must contain only objects or arrays"
		}
		return normalized, ""
	}

	width := -1
	for _, raw := range rows {
		row, ok := arrayItems(raw)
		if !ok {
			return nil, "sheet.append object rows require a header"
		}
		if len(row) == 0 || len(row) > sheetMaxColumns {
			return nil, "sheet.append rows must contain 1 to 200 cells"
		}
		if width == -1 {
			width = len(row)
		} else if len(row) != width {
			return nil, "sheet.append array rows must have a consistent width"
		}
		copyRow := make([]any, len(row))
		for index, value := range row {
			copyRow[index] = sheetSafeCell(value)
		}
		normalized = append(normalized, copyRow)
	}
	return normalized, ""
}

// sheetHeaderFor resolves the header for a FRESH sheet: explicit header
// first, sorted object keys second, nil (array rows) third.
func sheetHeaderFor(rows []any, header []string) []string {
	if len(header) > 0 {
		return header
	}
	if _, ok := rows[0].(map[string]any); ok {
		unique := map[string]bool{}
		for _, rawRow := range rows {
			row, rowOK := rawRow.(map[string]any)
			if !rowOK {
				continue
			}
			for key := range row {
				unique[key] = true
			}
		}
		keys := make([]string, 0, len(unique))
		for key := range unique {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		return keys
	}
	return nil
}

func sheetTools() []Definition {
	return []Definition{{
		Name: "sheet.append",
		Description: "Append rows to a named per-organization CSV sheet in the object store. " +
			"Creates the sheet on first append; later appends keep the sheet's existing columns. " +
			"Appends to the same sheet are serialized across Janusly replicas.",
		Required: []string{"name", "rows"},
		Optional: []string{"header"},
		Fields: []Field{
			{Name: "name", Type: "string", Required: true},
			{Name: "rows", Type: "array", Required: true},
			{Name: "header", Type: "array"},
		},
		InputExample: map[string]any{
			"name": "weekly-report", "rows": []any{map[string]any{"customer": "acme", "total": 42}},
		},
		Validate:  validateSheetInput,
		WriteSide: true,
		Execute: func(_ context.Context, _ map[string]any) (map[string]any, error) {
			return map[string]any{"ok": false, "provider": "noop", "error": "integration tools require run context"}, nil
		},
	}}
}

func executeSheetAppend(ctx context.Context, input map[string]any, deps *IntegrationDeps) map[string]any {
	start := time.Now()
	record := func(ok bool, errMessage string) {
		if deps != nil && deps.Record != nil {
			deps.Record("sheet.append", "", ok, 0, errMessage, int(time.Since(start).Milliseconds()))
		}
	}
	if err := validateSheetInput(input, InputValidationOptions{RequireAll: true}); err != nil {
		record(false, err.Error())
		return map[string]any{"ok": false, "provider": "noop", "error": err.Error()}
	}
	rows, _ := arrayItems(input["rows"])
	orgID := ""
	if deps != nil && deps.OrgID != nil {
		orgID = deps.OrgID()
	}
	name, _ := input["name"].(string)
	key := ""
	if orgID != "" {
		key = sheetObjectKey(orgID, name)
	}
	if key == "" {
		return map[string]any{"ok": false, "provider": "noop", "error": "sheet.append requires a sheet name"}
	}
	if deps != nil && deps.RateLimit != nil {
		rateLimit := 60
		if deps.RateLimitPerMin != nil {
			rateLimit = deps.RateLimitPerMin("sheet", 60)
		}
		if errMessage := deps.RateLimit(ctx, "sheet.append", rateLimit); errMessage != "" {
			record(false, errMessage)
			return map[string]any{"ok": false, "provider": "noop", "error": errMessage}
		}
	}
	rawHeader, headerPresent := input["header"]
	explicitHeader, headerError := normalizeSheetHeader(rawHeader, headerPresent)
	if headerError != "" {
		record(false, headerError)
		return map[string]any{"ok": false, "provider": "noop", "error": headerError}
	}
	if deps == nil || deps.Lock == nil {
		record(false, "sheet lock unavailable")
		return map[string]any{"ok": false, "provider": "noop", "error": "sheet lock unavailable"}
	}
	release, lockError := deps.Lock(ctx, "sheet.append:"+key)
	if lockError != "" || release == nil {
		if lockError == "" {
			lockError = "sheet lock unavailable"
		}
		record(false, lockError)
		return map[string]any{"ok": false, "provider": "noop", "error": lockError}
	}
	defer release()

	existing := objectstore.Get(ctx, "", key, sheetMaxBytes)
	var body string
	appended := len(rows)
	switch {
	case existing.Ok:
		current := strings.TrimRight(string(existing.Body), "\n")
		firstLine, _, _ := strings.Cut(current, "\n")
		var effective []string
		if parsed := parseCsvRows(firstLine); len(parsed) > 0 {
			effective = parsed[0]
		}
		if errMessage := validateSheetHeader(effective); errMessage != "" {
			record(false, "existing sheet header is invalid")
			return map[string]any{"ok": false, "provider": existing.Provider, "error": "existing sheet header is invalid"}
		}
		normalizedRows, errMessage := normalizeSheetRows(rows, effective)
		if errMessage != "" {
			record(false, errMessage)
			return map[string]any{"ok": false, "provider": existing.Provider, "error": errMessage}
		}
		rendered := StringifyCsv(normalizedRows, effective)
		if effective != nil {
			// StringifyCsv re-renders the header line; the sheet already
			// carries it.
			if _, rest, found := strings.Cut(rendered, "\n"); found {
				rendered = rest
			} else {
				rendered = ""
			}
		}
		if rendered == "" {
			record(true, "")
			return map[string]any{"ok": true, "provider": existing.Provider, "key": key, "appended": 0}
		}
		body = current + "\n" + rendered + "\n"
	case existing.NotFound:
		effective := sheetHeaderFor(rows, explicitHeader)
		if effective != nil {
			if errMessage := validateSheetHeader(effective); errMessage != "" {
				record(false, errMessage)
				return map[string]any{"ok": false, "provider": existing.Provider, "error": errMessage}
			}
		}
		normalizedRows, errMessage := normalizeSheetRows(rows, effective)
		if errMessage != "" {
			record(false, errMessage)
			return map[string]any{"ok": false, "provider": existing.Provider, "error": errMessage}
		}
		body = StringifyCsv(normalizedRows, effective) + "\n"
	default:
		record(false, existing.Error)
		return map[string]any{"ok": false, "provider": existing.Provider, "error": existing.Error}
	}
	if len(body) > sheetMaxBytes {
		record(false, "sheet full")
		return map[string]any{"ok": false, "provider": existing.Provider,
			"error": "sheet exceeds the 8 MiB bound; rotate to a new name"}
	}
	result := objectstore.Put(ctx, "", key, []byte(body), "text/csv")
	if !result.Ok {
		record(false, result.Error)
		return map[string]any{"ok": false, "provider": result.Provider, "error": result.Error}
	}
	record(true, "")
	return map[string]any{
		"ok": true, "provider": result.Provider, "url": result.URL,
		"key": result.Key, "appended": appended,
	}
}
