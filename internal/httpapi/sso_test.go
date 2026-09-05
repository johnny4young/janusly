package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeSsoRecordMatchesNodeBodyErrors(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		status  int
		code    string
		message string
	}{
		{"malformed", `{`, http.StatusBadRequest, "server_request_failed", "Invalid JSON body"},
		{"oversized", strings.Repeat("x", int(jsonRecordMaxBytes)+1), http.StatusRequestEntityTooLarge,
			"server_request_failed", "Request body too large. Limit is 1048576 bytes"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/org/sso/connections", strings.NewReader(tt.body))
			_, rejection := decodeSsoRecord(req)
			if rejection == nil || rejection.status != tt.status ||
				rejection.code != tt.code || rejection.message != tt.message {
				t.Fatalf("rejection = %+v", rejection)
			}
		})
	}

	req := httptest.NewRequest(http.MethodPost, "/org/sso/connections", strings.NewReader(`[]`))
	record, rejection := decodeSsoRecord(req)
	if rejection != nil || len(record) != 0 {
		t.Fatalf("valid non-record JSON must behave like asRecord({}): record=%v rejection=%+v", record, rejection)
	}
}

func TestRedirectNoStoreMatchesBrowserContract(t *testing.T) {
	recorder := httptest.NewRecorder()
	redirectNoStore(recorder, `https://example.com/continue?state=a"b`)
	if recorder.Code != http.StatusFound || recorder.Header().Get("Cache-Control") != "no-store" ||
		recorder.Header().Get("Location") != `https://example.com/continue?state=a"b` ||
		!strings.Contains(recorder.Body.String(), `state=a&quot;b`) {
		t.Fatalf("redirect = %d headers=%v body=%s", recorder.Code, recorder.Header(), recorder.Body.String())
	}
}
