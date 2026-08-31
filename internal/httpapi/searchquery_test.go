package httpapi

import (
	"strings"
	"testing"
)

func TestParseTextSearchQuery(t *testing.T) {
	tests := []struct {
		name     string
		raw      string
		want     string
		wantCode string
	}{
		{name: "empty", raw: " \t\n ", want: ""},
		{name: "unicode", raw: "  café  ", want: "café"},
		{name: "javascript does not trim next line", raw: "\u0085café\u0085", wantCode: "search_query_invalid_characters"},
		{name: "javascript trims byte order mark", raw: "\uFEFFcafé\uFEFF", want: "café"},
		{name: "literal metacharacters with indexable run", raw: `abc%_\`, want: `abc%_\`},
		{name: "non latin run", raw: "界界界", want: "界界界"},
		{name: "short ascii", raw: "ab", wantCode: "search_query_too_short"},
		{name: "separated letters", raw: "a b c", wantCode: "search_query_too_short"},
		{name: "punctuation has no trigram", raw: `%_\`, wantCode: "search_query_too_short"},
		{name: "combining mark splits a tiny run", raw: "e\u0301xy", wantCode: "search_query_too_short"},
		{name: "control character", raw: "abc\u001fdef", wantCode: "search_query_invalid_characters"},
		{name: "too long uses runes", raw: strings.Repeat("界", 101), wantCode: "search_query_too_long"},
		{name: "invalid utf8", raw: string([]byte{'a', 'b', 0xff}), wantCode: "search_query_invalid_utf8"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, bad := parseTextSearchQuery(test.raw, "q")
			if test.wantCode == "" {
				if bad != nil || got != test.want {
					t.Fatalf("parse = %q, %v; want %q", got, bad, test.want)
				}
				return
			}
			if bad == nil {
				t.Fatalf("parse = %q without error; want %s", got, test.wantCode)
			}
			if bad.code != test.wantCode {
				t.Fatalf("code = %q, want %q (result=%#v)", bad.code, test.wantCode, bad)
			}
		})
	}
}

func TestEscapeTextSearchLikePattern(t *testing.T) {
	if got, want := escapeTextSearchLikePattern(`a%_\b`), `a\%\_\\b`; got != want {
		t.Fatalf("escaped = %q, want %q", got, want)
	}
}
