// The formal jsonb persistence chokepoint, implements the contract's
// shared safe-persist helper. Stacks three sanitizers into one function so
// every jsonb-bound write shares the same gate: value-based redaction
// (optional caller-provided resolved-secret list — defense in depth over
// the engine's pre-write redaction), sensitive-key redaction (always on;
// reuses IsSensitiveKey — never fork the pattern), and size bounding
// (default 256 KB, env JANUSLY_PERSIST_MAX_BYTES, per-call override, or
// unbounded for the DLQ snapshots replay needs verbatim). An over-cap
// payload becomes the contract's {__truncated, originalBytes, maxBytes,
// preview} sentinel. Lives in grammar so the engine AND the audit writer
// reach it without a dependency cycle.
package grammar

import (
	"encoding/json"
	"math"
	"os"
	"strconv"
	"unicode/utf8"
)

// defaultPersistCap is the contract's DEFAULT_MAX_BYTES.
const defaultPersistCap = 256_000

// PersistUnbounded skips the truncation layer entirely (the contract's
// POSITIVE_INFINITY): DLQ workflow/node JSONs must replay byte-for-byte,
// but still get key-redacted.
const PersistUnbounded = -1

const persistPreviewDivisor = 2

// PersistOptions mirror the contract's SafePersistOptions.
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
// set to a positive integer, the contract's 256 KB otherwise.
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

// NormalizeJSON returns a value tree whose containers are visible to the
// redaction walkers. A fully transparent JSON tree is returned unchanged;
// typed maps/slices, structs, RawMessages, aliases, and other opaque values
// force a whole-tree JSON round trip so an opaque child cannot conceal a
// sensitive key or resolved value. Unsupported, cyclic, invalid-number, or
// panicking marshalers fail closed to an empty object.
func NormalizeJSON(value any) any {
	if isTransparentJSONTree(value, 0) {
		return value
	}
	raw, ok := marshalJSON(value)
	if !ok {
		return map[string]any{}
	}
	var out any
	if json.Unmarshal(raw, &out) != nil {
		return map[string]any{}
	}
	return out
}

// normalizeFastPathMaxDepth bounds the zero-allocation transparency scan.
// Deeper valid JSON falls back to encoding/json; cyclic maps/slices also fall
// back, where encoding/json rejects them instead of letting recursion escape.
const normalizeFastPathMaxDepth = 64

func isTransparentJSONTree(value any, depth int) bool {
	if depth > normalizeFastPathMaxDepth {
		return false
	}
	switch typed := value.(type) {
	case nil, bool, string,
		int, int8, int16, int32, int64,
		uint, uint8, uint16, uint32, uint64, uintptr:
		return true
	case float32:
		return !math.IsNaN(float64(typed)) && !math.IsInf(float64(typed), 0)
	case float64:
		return !math.IsNaN(typed) && !math.IsInf(typed, 0)
	case []any:
		for _, item := range typed {
			if !isTransparentJSONTree(item, depth+1) {
				return false
			}
		}
		return true
	case map[string]any:
		for _, item := range typed {
			if !isTransparentJSONTree(item, depth+1) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func marshalJSON(value any) (raw []byte, ok bool) {
	defer func() {
		if recover() != nil {
			raw, ok = nil, false
		}
	}()
	raw, err := json.Marshal(value)
	return raw, err == nil
}

// BoundPersistPayload returns raw unchanged when it fits, or a truncation
// sentinel that itself fits inside maxBytes. The preview is chosen with a
// binary search over the already-marshaled JSON prefix because quoting that
// prefix a second time can expand backslashes and quotes. A fixed "half the
// cap" preview therefore is not, by itself, a real byte bound.
func BoundPersistPayload(raw json.RawMessage, maxBytes int) json.RawMessage {
	if len(raw) <= maxBytes {
		return raw
	}
	build := func(previewBytes int) json.RawMessage {
		sentinel, err := json.Marshal(map[string]any{
			"__truncated":   true,
			"originalBytes": len(raw),
			"maxBytes":      maxBytes,
			"preview":       slicePersistUTF8(string(raw), previewBytes),
		})
		if err != nil {
			return nil
		}
		return sentinel
	}

	// Preserve the historical half-cap privacy/diagnostic ceiling, but shrink
	// further when JSON escaping plus sentinel metadata would cross the cap.
	low, high := 0, min(len(raw), maxBytes/persistPreviewDivisor)
	best := build(0)
	if len(best) == 0 || len(best) > maxBytes {
		minimal := json.RawMessage(`{"__truncated":true}`)
		if len(minimal) <= maxBytes {
			return minimal
		}
		// Pathological caller caps smaller than the marker cannot carry both a
		// valid marker and the promised byte bound. Return the smallest JSON
		// object; production call sites use caps of at least several KiB.
		return json.RawMessage(`{}`)
	}
	for low <= high {
		mid := low + (high-low)/2
		candidate := build(mid)
		if len(candidate) > 0 && len(candidate) <= maxBytes {
			best = candidate
			low = mid + 1
		} else {
			high = mid - 1
		}
	}
	return best
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
