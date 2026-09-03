package executors

import (
	"encoding/json"
	"unicode/utf8"

	"github.com/johnny4young/janusly/internal/aiguidance"
	"github.com/johnny4young/janusly/internal/grammar"
)

const (
	modelContextMaxBytes         = 64 * 1024
	modelPlannerDataMaxBytes     = 32 * 1024
	modelPlannerEnvelopeMaxBytes = 128 * 1024
	modelAIEnvelopeMaxBytes      = 384 * 1024
	modelOperatorTaskMaxChars    = 64 * 1024
	modelSystemExtensionMaxChars = 16 * 1024
	modelOutputMaxBytes          = 64 * 1024
	// A provider-compatible simulator or alternate client can ignore token
	// limits. Reject pathological replies before secret-shape regexes inspect
	// them; the smaller modelOutputMaxBytes remains the persisted/wire cap.
	modelRawOutputMaxBytes   = 256 * 1024
	modelNodeMaxOutputUnits  = 4_096
	agentPlanInputMaxBytes   = 32 * 1024
	agentFinalAnswerMaxBytes = 16 * 1024
	agentPlanReasonMaxBytes  = 2 * 1024
)

// modelSafeValue creates a model-facing copy that removes both exact
// secret/env literals resolved by the dispatcher and values under
// credential-shaped keys. The execution config itself remains untouched.
func modelSafeValue(value any, redactedValues []string) any {
	normalized := grammar.NormalizeJSON(value)
	normalized = grammar.RedactValues(normalized, redactedValues)
	return grammar.RedactSensitiveKeys(normalized)
}

// modelSafeText adds the AI-guidance secret-shape scrub to exact-value
// redaction. It is appropriate for serialized prompts and custom system
// prompts, never for the actual tool input that must retain credentials.
func modelSafeText(value string, redactedValues []string) string {
	return aiguidance.ScrubGuidanceSecrets(
		grammar.RedactString(value, redactedValues),
	)
}

// modelSafeBoundedValue preserves valid JSON while enforcing a byte cap. An
// oversized value becomes grammar's explicit truncation sentinel rather than
// malformed partial JSON, so the model can tell that evidence is incomplete.
func modelSafeBoundedValue(value any, redactedValues []string, maxBytes int) any {
	raw := grammar.SafePersistPayload(modelSafeValue(value, redactedValues), grammar.PersistOptions{
		RedactedValues: redactedValues,
		MaxBytes:       maxBytes,
	})
	var bounded any
	if json.Unmarshal(raw, &bounded) != nil {
		return map[string]any{"__truncated": true}
	}
	return bounded
}

// modelBoundedText truncates by Unicode code point, matching the user-facing
// ai.promptMaxChars contract without splitting UTF-8.
func modelBoundedText(value string, maxChars int) string {
	if maxChars <= 0 || utf8.RuneCountInString(value) <= maxChars {
		return value
	}
	runes := []rune(value)
	return string(runes[:maxChars])
}

// modelBoundedBytes is the storage-facing counterpart to modelBoundedText:
// it enforces a UTF-8 byte budget without cutting a code point.
func modelBoundedBytes(value string, maxBytes int) (string, bool) {
	if maxBytes <= 0 || len(value) <= maxBytes {
		return value, false
	}
	cut := maxBytes
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut], true
}

// modelSafeOutputValue recursively scrubs secret shapes from model-authored
// string leaves in addition to the exact-value and sensitive-key redaction
// already applied to model inputs. Provider output is untrusted data too.
func modelSafeOutputValue(value any, redactedValues []string) any {
	var scrub func(any) any
	scrub = func(current any) any {
		switch typed := current.(type) {
		case string:
			return modelSafeText(typed, redactedValues)
		case []any:
			out := make([]any, len(typed))
			for index := range typed {
				out[index] = scrub(typed[index])
			}
			return out
		case map[string]any:
			out := make(map[string]any, len(typed))
			for key, item := range typed {
				out[key] = scrub(item)
			}
			return out
		default:
			return typed
		}
	}
	return scrub(modelSafeValue(value, redactedValues))
}

// modelSafeBoundedOutputValue returns a copy safe to execute or persist. An
// oversize tree is rejected rather than handing a truncation sentinel to a
// tool as though it were the model's requested input.
func modelSafeBoundedOutputValue(value any, redactedValues []string, maxBytes int) (any, bool) {
	raw := grammar.SafePersistPayload(modelSafeOutputValue(value, redactedValues), grammar.PersistOptions{
		RedactedValues: redactedValues,
		MaxBytes:       maxBytes,
	})
	var bounded any
	if json.Unmarshal(raw, &bounded) != nil {
		return nil, false
	}
	if marker, ok := bounded.(map[string]any); ok && marker["__truncated"] == true {
		return nil, false
	}
	return bounded, true
}

func modelSafeOutputText(value string, redactedValues []string, maxBytes int) (string, bool) {
	return modelBoundedBytes(modelSafeText(value, redactedValues), maxBytes)
}
