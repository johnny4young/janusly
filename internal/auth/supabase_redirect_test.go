package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// Go strips Authorization on cross-origin redirects but not custom headers,
// so a redirecting Supabase URL would leak the project key to wherever it
// pointed. The client refuses to follow redirects at all.
func TestSupabaseClientNeverFollowsRedirectsWithProjectKey(t *testing.T) {
	var leaked atomic.Int32
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("apikey") != "" || r.Header.Get("Authorization") != "" {
			leaked.Add(1)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"user-1","email":"a@b.c"}`))
	}))
	defer sink.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, sink.URL+"/auth/v1/user", http.StatusFound)
	}))
	defer origin.Close()

	if _, _, ok := verifySupabaseUser(context.Background(), origin.URL, "project-key", "user-token"); ok {
		t.Fatal("a redirect response must not verify a user")
	}
	if leaked.Load() != 0 {
		t.Fatalf("redirect target received credentials %d time(s)", leaked.Load())
	}
}
