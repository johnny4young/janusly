package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNormalizedIdentityNameUsesNodeUTF16Length(t *testing.T) {
	if got := normalizedIdentityName("  Ada   Lovelace  ", 100); got != "Ada Lovelace" {
		t.Fatalf("whitespace normalization: %q", got)
	}
	// Emoji consumes two JavaScript UTF-16 code units but four UTF-8 bytes.
	if got := normalizedIdentityName(strings.Repeat("😀", 40), 80); got == "" {
		t.Fatal("80 UTF-16 code units must fit the Node contract")
	}
	if got := normalizedIdentityName(strings.Repeat("😀", 41), 80); got != "" {
		t.Fatal("82 UTF-16 code units must exceed the Node contract")
	}
}

func TestDecodeIdentityRecordMatchesNodeBodyErrors(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		status  int
		code    string
		message string
	}{
		{"malformed", `{`, http.StatusBadRequest, "server_request_failed", "Invalid JSON body"},
		{"oversized", strings.Repeat("x", int(identityMaxJSONBodyBytes)+1), http.StatusRequestEntityTooLarge,
			"server_request_failed", "Request body too large. Limit is 1048576 bytes"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/organizations", strings.NewReader(tt.body))
			_, rejection := decodeIdentityRecord(req)
			if rejection == nil || rejection.status != tt.status || rejection.code != tt.code || rejection.message != tt.message {
				t.Fatalf("rejection = %+v", rejection)
			}
		})
	}

	req := httptest.NewRequest("POST", "/organizations", strings.NewReader(`[]`))
	record, rejection := decodeIdentityRecord(req)
	if rejection != nil || len(record) != 0 {
		t.Fatalf("valid non-record JSON must behave like asRecord({}): record=%v rejection=%+v", record, rejection)
	}
}
