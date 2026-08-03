package executors

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestFetchHTTPTargetCanRefuseCredentialBearingRedirects(t *testing.T) {
	t.Setenv("ALLOW_PRIVATE_HTTP_TARGETS", "true")
	var received atomic.Int32
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		received.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(receiver.Close)
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, receiver.URL, http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirector.Close)

	result, err := FetchHTTPTarget(t.Context(), redirector.URL, FetchOptions{
		Method: http.MethodPost, Body: []byte("client_secret=must-not-move"),
		DisableRedirects: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.StatusCode != http.StatusTemporaryRedirect || result.Ok || received.Load() != 0 {
		t.Fatalf("redirect result=%+v receiverCalls=%d", result, received.Load())
	}
}
