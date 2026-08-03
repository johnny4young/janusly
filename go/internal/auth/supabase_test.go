package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestVerifySupabaseRejectsOversizedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"` + strings.Repeat("x", supabaseUserResponseMaxBytes) + `"}`))
	}))
	t.Cleanup(server.Close)

	if _, _, ok := verifySupabaseUser(context.Background(), server.URL, "project-key", "user-token"); ok {
		t.Fatal("oversized Supabase response must fail closed")
	}
}
