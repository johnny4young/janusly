package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// The web client sends its resolved UI locale on every request; the AI
// surfaces must follow it, and must never turn an arbitrary tag into a
// free-text instruction to the model.
func TestLocaleFromRequestHonorsShippedLanguagesOnly(t *testing.T) {
	cases := map[string]string{
		"":                         "en",
		"en":                       "en",
		"en-US,en;q=0.9":           "en",
		"es":                       "es",
		"es-419,es;q=0.9,en;q=0.8": "es",
		"fr-FR,fr;q=0.9,es;q=0.8":  "es",
		"fr-FR":                    "en",
		"zz-not-a-language":        "en",
		"  ES-mx  ":                "es",
	}
	for header, want := range cases {
		request := httptest.NewRequest("GET", "/ai/explain-workflow", nil)
		if header != "" {
			request.Header.Set("Accept-Language", header)
		}
		if got := localeFromRequest(request); got != want {
			t.Errorf("Accept-Language %q: got %q, want %q", header, got, want)
		}
	}
}

func TestLocaleInstructionRidesOnlyNonDefaultLanguages(t *testing.T) {
	if got := localeInstruction("en"); got != "" {
		t.Fatalf("English is the model default and must add nothing, got %q", got)
	}
	if got := localeInstruction("zz"); got != "" {
		t.Fatalf("an unsupported locale must add nothing, got %q", got)
	}
	spanish := localeInstruction("es")
	if !strings.Contains(spanish, "Spanish") || !strings.Contains(spanish, "identifiers") {
		t.Fatalf("Spanish instruction must name the language and protect identifiers: %q", spanish)
	}

	request := httptest.NewRequest("GET", "/ai/review-workflow", nil)
	request.Header.Set("Accept-Language", "es-CO")
	system := withLocale("BASE PROMPT", request)
	if !strings.HasPrefix(system, "BASE PROMPT") {
		t.Fatal("the locale rider must append, so a cached system prefix still matches")
	}
	if !strings.Contains(system, "Spanish") {
		t.Fatalf("expected the Spanish rider: %q", system)
	}
}
