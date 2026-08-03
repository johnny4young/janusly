// free_json extraction — the measured-reliability piece of the default
// generation mode (the project's finding: free-JSON beat constrained).
// ExtractJSONObject is the reference's exact grammar: strip markdown
// fences, slice the outermost object. ParseJSONValue layers the pilot's
// hardening on top per the wave card: BOM/unicode tolerance, top-level
// arrays, and a bounded repair for TRUNCATED model output (a valid prefix
// cut mid-stream gets its open strings/brackets closed). Extraction can
// never throw — a hopeless input yields (nil, false) and the caller's
// fallback contract takes over.
package ai

import (
	"encoding/json"
	"regexp"
	"slices"
	"strings"
)

var fencePattern = regexp.MustCompile("(?i)```(?:json)?")

// ExtractJSONObject ports the reference's extractJsonObject verbatim:
// trim, strip fences, slice first '{' to last '}', else the trimmed text.
func ExtractJSONObject(text string) string {
	t := strings.TrimSpace(strings.TrimPrefix(text, "\uFEFF"))
	t = strings.TrimSpace(fencePattern.ReplaceAllString(t, ""))
	first := strings.IndexByte(t, '{')
	last := strings.LastIndexByte(t, '}')
	if first >= 0 && last > first {
		return t[first : last+1]
	}
	return t
}

// ParseJSONValue extracts and decodes a JSON object or array from free
// model text: fences and surrounding prose stripped, BOM tolerated,
// top-level arrays accepted, and a truncated-but-valid prefix repaired by
// closing its open strings and brackets. Returns (nil, false) when no
// candidate parses — never an error, never a panic.
func ParseJSONValue(text string) (any, bool) {
	candidates := []string{ExtractJSONObject(text)}
	// Top-level array: the object slice found nothing bracketed.
	trimmed := strings.TrimSpace(strings.TrimPrefix(text, "\uFEFF"))
	trimmed = strings.TrimSpace(fencePattern.ReplaceAllString(trimmed, ""))
	if first, last := strings.IndexByte(trimmed, '['), strings.LastIndexByte(trimmed, ']'); first >= 0 && last > first {
		candidates = append(candidates, trimmed[first:last+1])
	}
	for _, candidate := range candidates {
		var value any
		if json.Unmarshal([]byte(candidate), &value) == nil {
			switch value.(type) {
			case map[string]any, []any:
				return value, true
			}
		}
		if repaired, ok := repairTruncated(candidate); ok {
			var value any
			if json.Unmarshal([]byte(repaired), &value) == nil {
				switch value.(type) {
				case map[string]any, []any:
					return value, true
				}
			}
		}
	}
	return nil, false
}

// repairTruncated walks a JSON prefix with a string/escape-aware stack;
// when the text is a structurally valid prefix cut mid-stream, it closes
// the open string and brackets. A dangling partial token (`"key":` or a
// trailing comma) is trimmed back to the last complete element first.
func repairTruncated(text string) (string, bool) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" || (trimmed[0] != '{' && trimmed[0] != '[') {
		return "", false
	}
	var stack []byte
	inString, escaped := false, false
	for i := 0; i < len(trimmed); i++ {
		ch := trimmed[i]
		if inString {
			if escaped {
				escaped = false
			} else if ch == '\\' {
				escaped = true
			} else if ch == '"' {
				inString = false
			}
			continue
		}
		switch ch {
		case '"':
			inString = true
		case '{', '[':
			stack = append(stack, ch)
		case '}':
			if len(stack) == 0 || stack[len(stack)-1] != '{' {
				return "", false
			}
			stack = stack[:len(stack)-1]
		case ']':
			if len(stack) == 0 || stack[len(stack)-1] != '[' {
				return "", false
			}
			stack = stack[:len(stack)-1]
		}
	}
	if len(stack) == 0 && !inString {
		return "", false // already balanced; the parse failure was semantic
	}
	repaired := trimmed
	if inString {
		if escaped {
			repaired = repaired[:len(repaired)-1]
		}
		repaired += `"`
	}
	// Trim a dangling `"key":` or trailing comma so the closers parse.
	repaired = strings.TrimRight(repaired, " \t\n\r")
	repaired = strings.TrimSuffix(repaired, ",")
	if strings.HasSuffix(strings.TrimRight(repaired, " \t\n\r"), ":") {
		repaired = strings.TrimRight(repaired, " \t\n\r")
		repaired += "null"
	}
	for _, v := range slices.Backward(stack) {
		if v == '{' {
			repaired += "}"
		} else {
			repaired += "]"
		}
	}
	return repaired, true
}
