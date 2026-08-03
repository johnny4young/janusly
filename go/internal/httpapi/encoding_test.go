package httpapi

import (
	"io"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestReadRawBodyEnforcesHardCap(t *testing.T) {
	t.Run("exact cap preserves bytes", func(t *testing.T) {
		request := httptest.NewRequest("POST", "/signed", strings.NewReader("abcd"))
		response := httptest.NewRecorder()
		raw, ok := readRawBody(response, request, 4)
		if !ok || string(raw) != "abcd" || response.Code != 200 {
			t.Fatalf("raw=%q ok=%v status=%d", raw, ok, response.Code)
		}
	})

	t.Run("oversized body is rejected rather than truncated", func(t *testing.T) {
		request := httptest.NewRequest("POST", "/signed", strings.NewReader("abcde"))
		response := httptest.NewRecorder()
		raw, ok := readRawBody(response, request, 4)
		if ok || raw != nil || response.Code != 413 {
			t.Fatalf("raw=%q ok=%v status=%d", raw, ok, response.Code)
		}
		body, err := io.ReadAll(response.Result().Body)
		if err != nil {
			t.Fatalf("read response: %v", err)
		}
		for _, expected := range []string{
			`"code":"server_request_failed"`,
			`"error":"Request body too large. Limit is 4 bytes"`,
		} {
			if !strings.Contains(string(body), expected) {
				t.Fatalf("response %s does not contain %s", body, expected)
			}
		}
	})
}
