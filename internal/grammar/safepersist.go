// The formal jsonb persistence chokepoint, ported from the reference's
// shared safe-persist helper. Stacks three sanitizers into one function so
// every jsonb-bound write shares the same gate: value-based redaction
// (optional caller-provided resolved-secret list — defense in depth over
// the engine's pre-write redaction), sensitive-key redaction (always on;
// reuses IsSensitiveKey — never fork the pattern), and size bounding
// (default 256 KB, env JANUSLY_PERSIST_MAX_BYTES, per-call override, or
// unbounded for the DLQ snapshots replay needs verbatim). An over-cap
// payload becomes the reference's {__truncated, originalBytes, maxBytes,
// preview} sentinel. Lives in grammar so the engine AND the audit writer
// reach it without a dependency cycle.
package grammar

import (
	"encoding/json"
	"os"
	"strconv"
	"unicode/utf8"
)

// defaultPersistCap is the reference's DEFAULT_MAX_BYTES.
const defaultPersistCap = 256_000

// PersistUnbounded skips the truncation layer entirely (the reference's
// POSITIVE_INFINITY): DLQ workflow/node JSONs must replay byte-for-byte,
// but still get key-redacted.
const PersistUnbounded = -1

const persistPreviewDivisor = 2

// PersistOptions mirror the reference's SafePersistOptions.
type PersistOptions struct {
	// RedactedValues holds per-run resolved secrets to scrub from string
	// occurrences. Optional — engine paths usually pre-redact at dispatch.
	RedactedValues []string
	// MaxBytes: 0 resolves the default (env JANUSLY_PERSIST_MAX_BYTES or
	// 256 KB); PersistUnbounded skips truncation; any positive value is an
	// explicit per-call cap.
	MaxBytes int
}

// DefaultPersistMaxBytes resolves the default cap: the env override when
// set to a positive integer, the reference's 256 KB otherwise.
func DefaultPersistMaxBytes() int {
	if raw := os.Getenv("JANUSLY_PERSIST_MAX_BYTES"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			return n
		}
	}
	return defaultPersistCap
}

// SafePersistPayload runs a payload through the value/key/size stack and
// returns marshaled JSON safe for a jsonb column. Never fails: a payload
// JSON cannot represent collapses to an empty object rather than breaking
// the write it describes.
func SafePersistPayload(value any, opts PersistOptions) json.RawMessage {
	working := NormalizeJSON(value)
	if len(opts.RedactedValues) > 0 {
		working = RedactValues(working, opts.RedactedValues)
	}
	raw, err := json.Marshal(RedactSensitiveKeys(working))
	if err != nil {
		return json.RawMessage(`{}`)
	}
	cap := opts.MaxBytes
	if cap == 0 {
		cap = DefaultPersistMaxBytes()
	}
	if cap < 0 {
		return raw
	}
	return BoundPersistPayload(raw, cap)
}

// NormalizeJSON round-trips non-basic values through JSON so the redaction
// walkers see plain maps/slices regardless of the caller's types.
func NormalizeJSON(value any) any {
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

// BoundPersistPayload returns raw unchanged when it fits, or the
// reference's truncation sentinel with the leading half-cap bytes as
// preview, cut on a rune boundary.
func BoundPersistPayload(raw json.RawMessage, maxBytes int) json.RawMessage {
	if len(raw) <= maxBytes {
		return raw
	}
	sentinel, err := json.Marshal(map[string]any{
		"__truncated":   true,
		"originalBytes": len(raw),
		"maxBytes":      maxBytes,
		"preview":       slicePersistUTF8(string(raw), maxBytes/persistPreviewDivisor),
	})
	if err != nil {
		return json.RawMessage(`{"__truncated":true}`)
	}
	return sentinel
}

// slicePersistUTF8 cuts s to at most limit bytes without splitting a rune.
func slicePersistUTF8(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}
