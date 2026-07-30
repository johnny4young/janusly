// Value-based redaction, ported from the shared safe-persist helper: every
// occurrence of a tracked secret/env literal inside a value tree is replaced
// before persistence. Callers pass the redaction list collected by
// RenderTemplateWithRedactions.
package grammar

import "strings"

// RedactedPlaceholder is the literal that replaces matched values.
const RedactedPlaceholder = "[redacted]"

// RedactValues recursively replaces any string occurrence of the given
// values with the redaction placeholder. Non-string leaves pass through
// untouched; maps and slices are rebuilt, never mutated.
func RedactValues(value any, redactedValues []string) any {
	if len(redactedValues) == 0 {
		return value
	}
	switch v := value.(type) {
	case string:
		return RedactString(v, redactedValues)
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = RedactValues(item, redactedValues)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[key] = RedactValues(item, redactedValues)
		}
		return out
	default:
		return value
	}
}

// RedactString replaces every occurrence of each redacted value in s.
func RedactString(s string, redactedValues []string) string {
	for _, secret := range redactedValues {
		if secret == "" {
			continue
		}
		s = strings.ReplaceAll(s, secret, RedactedPlaceholder)
	}
	return s
}
