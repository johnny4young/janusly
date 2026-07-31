// Prompt-injection hardening for MCP-discovered prose, ported from the
// reference's sanitizeMcpToolDescription / sanitizeMcpPromptLabel:
// descriptions and labels arrive from THIRD-PARTY MCP servers and are
// treated as untrusted prompt data. The pass order is fixed — NFKC
// normalization + Unicode-injection-block strip FIRST (zero-width, RTL
// overrides, invisible operators, BOM), then ASCII control-char strip,
// then the secret scrub, then the length cap. Homoglyph look-alikes
// (Cyrillic е etc.) deliberately pass: they are legitimate in non-Latin
// descriptions; the expose_to_ai opt-in covers the residual risk.
package signature

import (
	"strings"

	"golang.org/x/text/unicode/norm"
)

// MaxMcpDescriptionChars bounds one description's prompt-injection blast
// radius (reference MAX_MCP_DESCRIPTION_CHARS).
const MaxMcpDescriptionChars = 300

// MaxMcpPromptLabelChars bounds prompt-facing aliases / tool names
// (reference MAX_MCP_PROMPT_LABEL_CHARS).
const MaxMcpPromptLabelChars = 120

// unicodeInjectionRune reports membership in the closed injection block:
// U+200B–U+200F, U+202A–U+202E, U+2060–U+206F, U+FEFF.
func unicodeInjectionRune(r rune) bool {
	switch {
	case r >= 0x200b && r <= 0x200f:
		return true
	case r >= 0x202a && r <= 0x202e:
		return true
	case r >= 0x2060 && r <= 0x206f:
		return true
	case r == 0xfeff:
		return true
	}
	return false
}

func controlRune(r rune) bool {
	return r <= 0x1f || r == 0x7f
}

// applyUnicodeHardening NFKC-normalizes and drops the injection block.
// Pure, idempotent, a no-op on ASCII and on legitimate non-Latin text.
func applyUnicodeHardening(input string) string {
	normalized := norm.NFKC.String(input)
	var b strings.Builder
	b.Grow(len(normalized))
	for _, r := range normalized {
		if unicodeInjectionRune(r) {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// SanitizeMcpToolDescription hardens one discovered description before it
// may reach a prompt: Unicode hardening → control chars to spaces →
// secret scrub → 300-char cap with ellipsis. Empty input returns the
// stable "(no description)" placeholder.
func SanitizeMcpToolDescription(description string) string {
	if description == "" {
		return "(no description)"
	}
	unicoded := applyUnicodeHardening(description)
	stripped := strings.Map(func(r rune) rune {
		if controlRune(r) {
			return ' '
		}
		return r
	}, unicoded)
	scrubbed := ScrubSecretShapes(stripped)
	runes := []rune(scrubbed)
	if len(runes) <= MaxMcpDescriptionChars {
		return scrubbed
	}
	return string(runes[:MaxMcpDescriptionChars-1]) + "…"
}

// SanitizeMcpPromptLabel produces a safe prompt-facing label for an MCP
// alias or tool name — an AI-awareness label, never the canonical runtime
// name. Anything outside [A-Za-z0-9_.-] collapses to "_".
func SanitizeMcpPromptLabel(label, fallback string) string {
	if fallback == "" {
		fallback = "unnamed"
	}
	if label == "" {
		return fallback
	}
	unicoded := applyUnicodeHardening(label)
	stripped := ScrubSecretShapes(strings.Map(func(r rune) rune {
		if controlRune(r) {
			return ' '
		}
		return r
	}, unicoded))
	var b strings.Builder
	for _, r := range strings.TrimSpace(stripped) {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9',
			r == '_', r == '.', r == '-':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	safe := b.String()
	for strings.Contains(safe, "__") {
		safe = strings.ReplaceAll(safe, "__", "_")
	}
	safe = strings.Trim(safe, "_")
	if safe == "" {
		return fallback
	}
	runes := []rune(safe)
	if len(runes) > MaxMcpPromptLabelChars {
		safe = string(runes[:MaxMcpPromptLabelChars])
	}
	return safe
}
