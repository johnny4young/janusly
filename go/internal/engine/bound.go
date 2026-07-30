// Size bounding for persisted jsonb payloads, ported from the reference's
// safe-persist chokepoint: an over-cap payload is replaced by a well-formed
// sentinel the operator can spot in raw rows. Sensitive-key redaction (the
// other half of that chokepoint) arrives with the http/tool executors, which
// are the first writers of secret-shaped material.
package engine

import (
	"encoding/json"
	"unicode/utf8"
)

// Caps mirror the reference: node output state at 1 MB, and the succeeded
// event inlines the output only up to 8 KB (larger outputs keep the event
// small — the node row already stores them).
const (
	stateJSONMaxBytes             = 1_000_000
	nodeSucceededOutputMaxBytes   = 8_000
	truncationPreviewDivisor      = 2
)

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
