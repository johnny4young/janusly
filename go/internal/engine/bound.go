// Engine-side shim over the formal jsonb chokepoint in grammar (the
// reference keeps the same split: shared safe-persist + an engine re-export
// so internal import paths stay short). The per-column caps live here; the
// value/key/size sanitizer stack lives in grammar.SafePersistPayload.
package engine

import (
	"encoding/json"

	"github.com/johnny4young/janusly/go/internal/grammar"
)

// Caps mirror the reference: node output state at 1 MB, the succeeded
// event inlines the output only up to 8 KB, dead-letter errors at 64 KB,
// and everything else uses the chokepoint default (256 KB, env
// JANUSLY_PERSIST_MAX_BYTES).
const (
	stateJSONMaxBytes           = 1_000_000
	nodeSucceededOutputMaxBytes = 8_000
	deadLetterErrorMaxBytes     = 64_000
)

// defaultPersistMaxBytes defers to the chokepoint's env-aware default.
func defaultPersistMaxBytes() int { return grammar.DefaultPersistMaxBytes() }

// safePersist is the engine's jsonb write gate: sensitive-shaped keys
// redact, then the result is size-bounded (maxBytes <= 0 = never truncate —
// dead letters need the exact JSON for replay, but still get key-redacted).
func safePersist(value any, maxBytes int) json.RawMessage {
	if maxBytes <= 0 {
		maxBytes = grammar.PersistUnbounded
	}
	return grammar.SafePersistPayload(value, grammar.PersistOptions{MaxBytes: maxBytes})
}
