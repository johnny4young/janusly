// sheet.append — the report-to-spreadsheet sink. Appends rows to a named
// per-org CSV object in the configured object store: the first append
// creates the sheet (header from `header` or, for object rows, sorted
// keys), later appends align to the SHEET'S existing header so columns
// stay stable no matter what shape later rows arrive in.
//
// Honest limits, stated up front: appends are read-modify-write with no
// object-store locking, so two simultaneous appends to one sheet can lose
// rows (last writer wins) — serialize writers per sheet when that
// matters. Sheets are bounded at 8 MiB.
package tools

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/johnny4young/janusly/internal/objectstore"
)

const (
	sheetMaxBytes       = 8 << 20
	sheetMaxRowsPerCall = 1000
)

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

// sheetHeaderFor resolves the header for a FRESH sheet: explicit header
// first, sorted object keys second, nil (array rows) third.
func sheetHeaderFor(rows []any, header []string) []string {
	if len(header) > 0 {
		return header
	}
	if first, ok := rows[0].(map[string]any); ok {
		keys := make([]string, 0, len(first))
		for key := range first {
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
			"Concurrent appends to one sheet are last-writer-wins.",
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
	rows, rowsOk := input["rows"].([]any)
	if !rowsOk || len(rows) == 0 {
		return map[string]any{"ok": false, "provider": "noop", "error": "sheet.append requires non-empty rows"}
	}
	if len(rows) > sheetMaxRowsPerCall {
		return map[string]any{"ok": false, "provider": "noop", "error": "sheet.append accepts at most 1000 rows per call"}
	}
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
	var explicitHeader []string
	if raw, present := input["header"].([]any); present {
		for _, cell := range raw {
			if text, ok := cell.(string); ok {
				explicitHeader = append(explicitHeader, text)
			}
		}
	}

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
		rendered := StringifyCsv(rows, effective)
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
		body = StringifyCsv(rows, sheetHeaderFor(rows, explicitHeader)) + "\n"
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
