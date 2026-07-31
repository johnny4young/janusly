// Value-based redaction, ported from the shared safe-persist helper: every
// occurrence of a tracked secret/env literal inside a value tree is replaced
// before persistence. Callers pass the redaction list collected by
// RenderTemplateWithRedactions.
package grammar

import (
	"regexp"
	"strings"
)

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

// sensitiveKeyPattern is the reference's closed list of secret-shaped object
// keys (packages/shared/src/sensitive-keys.ts) — secret*/password*/token*
// with separator or camel-case continuation, api key, authorization, cookie,
// x-api-key, client secret, private key.
var sensitiveKeyPattern = regexp.MustCompile(
	`^(?i:secret|password|token)((?-i:$|[_-].*|[A-Z].*))$|^(?i)(api[_-]?key|authorization|cookie|x-api-key|client[_-]?secret|private[_-]?key)$`,
)

// IsSensitiveKey reports whether an object key looks like credential
// material under the reference pattern.
func IsSensitiveKey(key string) bool {
	return sensitiveKeyPattern.MatchString(key)
}

// RedactSensitiveKeys deep-copies value, replacing the value of every
// sensitive-shaped key with the redaction placeholder. Arrays recurse;
// non-container leaves pass through.
func RedactSensitiveKeys(value any) any {
	switch v := value.(type) {
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = RedactSensitiveKeys(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			if IsSensitiveKey(key) {
				out[key] = RedactedPlaceholder
				continue
			}
			out[key] = RedactSensitiveKeys(item)
		}
		return out
	default:
		return value
	}
}
