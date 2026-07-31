// Size bounding for persisted jsonb payloads, ported from the reference's
// safe-persist chokepoint: an over-cap payload is replaced by a well-formed
// sentinel the operator can spot in raw rows. Sensitive-key redaction (the
// other half of that chokepoint) arrives with the http/tool executors, which
// are the first writers of secret-shaped material.
package engine

import (
	"encoding/json"
	"unicode/utf8"

	"github.com/johnny4young/janusly/go/internal/grammar"
)

// Caps mirror the reference: node output state at 1 MB, the succeeded
// event inlines the output only up to 8 KB, dead-letter errors at 64 KB,
// and everything else defaults to 256 KB.
const (
	stateJSONMaxBytes           = 1_000_000
	nodeSucceededOutputMaxBytes = 8_000
	deadLetterErrorMaxBytes     = 64_000
	defaultPersistMaxBytes      = 256_000
	truncationPreviewDivisor    = 2
)

// safePersist is the jsonb write chokepoint: sensitive-shaped keys redact,
// then the result is size-bounded (maxBytes 0 = never truncate — dead
// letters need the exact JSON for replay, but still get key-redacted).
func safePersist(value any, maxBytes int) json.RawMessage {
	raw, err := json.Marshal(grammar.RedactSensitiveKeys(normalizeJSON(value)))
	if err != nil {
		return json.RawMessage(`{}`)
	}
	if maxBytes <= 0 {
		return raw
	}
	return boundPayload(raw, maxBytes)
}

// normalizeJSON round-trips non-basic values through JSON so the key
// redactor sees plain maps/slices regardless of the caller's types.
func normalizeJSON(value any) any {
	switch value.(type) {
	case nil, bool, float64, string, map[string]any, []any:
		return value
	default:
		raw, err := json.Marshal(value)
		if err != nil {
			return value
		}
		var out any
		if json.Unmarshal(raw, &out) != nil {
			return value
		}
		return out
	}
}

// boundPayload returns raw unchanged when it fits, or the reference's
// truncation sentinel: {__truncated, originalBytes, maxBytes, preview} with
// the preview holding the leading half-cap bytes, cut on a rune boundary.
func boundPayload(raw json.RawMessage, maxBytes int) json.RawMessage {
	if len(raw) <= maxBytes {
		return raw
	}
	sentinel, err := json.Marshal(map[string]any{
		"__truncated":   true,
		"originalBytes": len(raw),
		"maxBytes":      maxBytes,
		"preview":       sliceUTF8(string(raw), maxBytes/truncationPreviewDivisor),
	})
	if err != nil {
		return json.RawMessage(`{"__truncated":true}`)
	}
	return sentinel
}

// sliceUTF8 cuts s to at most limit bytes without splitting a rune.
func sliceUTF8(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}
