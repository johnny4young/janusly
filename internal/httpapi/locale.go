// Operator-facing AI output follows the operator's UI language. The web
// client sends its resolved locale as Accept-Language on every request;
// the free-form AI surfaces (explain, review, suggest, patch rationale)
// append a one-line instruction so a Spanish operator does not read an
// English rationale. Generation is deliberately excluded: its output is a
// workflow document whose identifiers and expressions are not prose.
package httpapi

import (
	"net/http"
	"strings"
)

// supportedAILocales mirrors the product's shipped UI languages.
var supportedAILocales = map[string]string{
	"en": "English",
	"es": "Spanish",
}

// localeFromRequest resolves the caller's UI language from Accept-Language,
// defaulting to English. Only the shipped languages are honored — an
// unsupported tag must not become a free-text instruction to the model.
func localeFromRequest(r *http.Request) string {
	header := r.Header.Get("Accept-Language")
	for entry := range strings.SplitSeq(header, ",") {
		tag := strings.TrimSpace(entry)
		if semicolon := strings.IndexByte(tag, ';'); semicolon >= 0 {
			tag = strings.TrimSpace(tag[:semicolon])
		}
		if tag == "" {
			continue
		}
		base, _, _ := strings.Cut(strings.ToLower(tag), "-")
		if _, ok := supportedAILocales[base]; ok {
			return base
		}
	}
	return "en"
}

// localeInstruction is the sentence appended to a system prompt. English
// is the models' default posture, so it adds nothing.
func localeInstruction(locale string) string {
	language, ok := supportedAILocales[locale]
	if !ok || locale == "en" {
		return ""
	}
	return "\n\nWrite every human-readable field (explanations, rationales, messages, " +
		"suggestions) in " + language + ". Keep identifiers, JSON keys, node ids, " +
		"code, and template expressions exactly as they are."
}

// withLocale appends the locale instruction to a system prompt.
func withLocale(system string, r *http.Request) string {
	return system + localeInstruction(localeFromRequest(r))
}
