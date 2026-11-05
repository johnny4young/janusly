package mcpserver

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/johnny4young/janusly/internal/signature"
)

const maxMCPErrorSummaryRunes = 300

const (
	maxMCPIdentifierRunes = 256
	maxMCPCursorRunes     = 1024
)

func validMCPIdentifier(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && utf8.RuneCountInString(value) <= maxMCPIdentifierRunes
}

func validOptionalMCPIdentifier(value string) bool {
	return strings.TrimSpace(value) == "" || validMCPIdentifier(value)
}

func validOptionalMCPCursor(value string) bool {
	return utf8.RuneCountInString(value) <= maxMCPCursorRunes
}

func boundedMCPText(value string, maxRunes int) string {
	value = signature.ScrubSecretShapes(strings.TrimSpace(value))
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, value)
	value = strings.Join(strings.Fields(value), " ")
	runes := []rune(value)
	if len(runes) > maxRunes {
		return string(runes[:maxRunes-1]) + "…"
	}
	return value
}

// safeErrorProjection intentionally whitelists only classification fields.
// Persisted errors may contain arbitrary provider evidence, so returning a
// redacted raw blob would still violate the MCP bounded-evidence contract.
func safeErrorProjection(raw json.RawMessage) map[string]any {
	view := map[string]any{"present": len(raw) > 0}
	if len(raw) == 0 {
		return view
	}
	var object map[string]any
	if json.Unmarshal(raw, &object) != nil {
		return view
	}
	for _, key := range []string{"code", "name", "class", "type"} {
		if value := scalarString(object[key]); value != "" {
			view[key] = boundedMCPText(value, 80)
		}
	}
	for _, key := range []string{"message", "error", "reason"} {
		if value := scalarString(object[key]); value != "" {
			view["summary"] = boundedMCPText(value, maxMCPErrorSummaryRunes)
			break
		}
	}
	return view
}

func scalarString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case float64, bool:
		return fmt.Sprint(typed)
	default:
		return ""
	}
}

// scrubSecretShapes removes secret-shaped literals from a JSON value before it
// enters a model's context. Template references and credential names survive.
func scrubSecretShapes(value any) any {
	switch typed := value.(type) {
	case string:
		return signature.ScrubSecretShapes(typed)
	case []any:
		out := make([]any, len(typed))
		for index, item := range typed {
			out[index] = scrubSecretShapes(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = scrubSecretShapes(item)
		}
		return out
	default:
		return value
	}
}
