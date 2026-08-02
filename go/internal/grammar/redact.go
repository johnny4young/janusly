// Value-based redaction, ported from the shared safe-persist helper: every
// occurrence of a tracked secret/env literal inside a value tree is replaced
// before persistence. Callers pass the redaction list collected by
// RenderTemplateWithRedactions.
package grammar

import (
	"maps"
	"regexp"
	"strings"
)

// RedactedPlaceholder is the literal that replaces matched values.
const RedactedPlaceholder = "[redacted]"

// RedactValues recursively replaces any string occurrence of the given
// values with the redaction placeholder. Non-string leaves pass through
// untouched. Copy-on-write: containers are rebuilt ONLY on an actual
// replacement underneath (T-508 — the chokepoint runs on every persisted
// event, and the overwhelmingly common payload has nothing to redact);
// the input tree is never mutated.
func RedactValues(value any, redactedValues []string) any {
	if len(redactedValues) == 0 {
		return value
	}
	out, _ := redactValuesCOW(value, redactedValues)
	return out
}

func redactValuesCOW(value any, redactedValues []string) (any, bool) {
	switch v := value.(type) {
	case string:
		replaced := RedactString(v, redactedValues)
		return replaced, replaced != v
	case []any:
		var out []any
		for i, item := range v {
			next, changed := redactValuesCOW(item, redactedValues)
			if !changed {
				continue
			}
			if out == nil {
				out = make([]any, len(v))
				copy(out, v)
			}
			out[i] = next
		}
		if out == nil {
			return v, false
		}
		return out, true
	case map[string]any:
		var out map[string]any
		for key, item := range v {
			next, changed := redactValuesCOW(item, redactedValues)
			if !changed {
				continue
			}
			if out == nil {
				out = make(map[string]any, len(v))
				maps.Copy(out, v)
			}
			out[key] = next
		}
		if out == nil {
			return v, false
		}
		return out, true
	default:
		return value, false
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

// RedactSensitiveKeys replaces the value of every sensitive-shaped key
// with the redaction placeholder. Copy-on-write, like RedactValues: a
// container is rebuilt only when a sensitive key (or a changed child)
// actually sits underneath, so clean payloads pass through alloc-free;
// the input tree is never mutated.
func RedactSensitiveKeys(value any) any {
	out, _ := redactKeysCOW(value)
	return out
}

func redactKeysCOW(value any) (any, bool) {
	switch v := value.(type) {
	case []any:
		var out []any
		for i, item := range v {
			next, changed := redactKeysCOW(item)
			if !changed {
				continue
			}
			if out == nil {
				out = make([]any, len(v))
				copy(out, v)
			}
			out[i] = next
		}
		if out == nil {
			return v, false
		}
		return out, true
	case map[string]any:
		var out map[string]any
		ensure := func() map[string]any {
			if out == nil {
				out = make(map[string]any, len(v))
				maps.Copy(out, v)
			}
			return out
		}
		for key, item := range v {
			if IsSensitiveKey(key) {
				ensure()[key] = RedactedPlaceholder
				continue
			}
			if next, changed := redactKeysCOW(item); changed {
				ensure()[key] = next
			}
		}
		if out == nil {
			return v, false
		}
		return out, true
	default:
		return value, false
	}
}
