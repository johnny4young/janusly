package httpapi

import (
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	textSearchMinIndexableRunes = 3
	textSearchMaxRunes          = 100
)

// parseTextSearchQuery owns the shared substring-search boundary. Empty input
// means "no search". A non-empty query must be valid UTF-8, stay within the
// Unicode code-point cap, avoid control characters, and contain a contiguous
// run that PostgreSQL can turn into a selective trigram. Punctuation remains
// valid literal content when the same term also contains an indexable run.
func parseTextSearchQuery(raw, field string) (string, *opResult) {
	value := strings.TrimFunc(raw, func(r rune) bool {
		// Match ECMAScript String.trim exactly at the browser/API boundary:
		// Go treats NEL as space but JavaScript does not, while JavaScript also
		// trims the BOM code point that Go leaves intact.
		return r == '\uFEFF' || (r != '\u0085' && unicode.IsSpace(r))
	})
	if value == "" {
		return "", nil
	}
	if !utf8.ValidString(value) {
		result := opError(http.StatusBadRequest, "search_query_invalid_utf8", "Search query must be valid UTF-8",
			map[string]any{"field": field})
		return "", &result
	}
	if utf8.RuneCountInString(value) > textSearchMaxRunes {
		result := opError(http.StatusBadRequest, "search_query_too_long", "Search query is too long",
			map[string]any{"field": field, "maxChars": textSearchMaxRunes})
		return "", &result
	}

	longestRun := 0
	currentRun := 0
	for _, r := range value {
		if unicode.IsControl(r) {
			result := opError(http.StatusBadRequest, "search_query_invalid_characters", "Search query contains control characters",
				map[string]any{"field": field})
			return "", &result
		}
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			currentRun++
			longestRun = max(longestRun, currentRun)
			continue
		}
		currentRun = 0
	}
	if longestRun < textSearchMinIndexableRunes {
		result := opError(http.StatusBadRequest, "search_query_too_short", "Search query needs an indexable character sequence",
			map[string]any{"field": field, "minChars": textSearchMinIndexableRunes})
		return "", &result
	}
	return value, nil
}

// escapeTextSearchLikePattern makes every user character literal under ILIKE.
func escapeTextSearchLikePattern(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}
