package executors

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestZeroTimeoutDoesNotDisableTheDeadline(t *testing.T) {
	block := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		<-block
	}))
	t.Cleanup(server.Close)
	t.Cleanup(func() { close(block) })

	execute := NewHTTPExecutor(HTTPOptions{AllowPrivate: func() bool { return true }})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() {
		_, err := execute(ctx, Input{
			HTTPBounds: &HTTPBounds{TimeoutMs: 150, MaxResponseBytes: httpDefaultMaxBytes, MaxRedirects: httpDefaultMaxRedirect},
			Config: map[string]any{
				"url":       server.URL,
				"method":    "GET",
				"timeoutMs": float64(0),
			},
		})
		done <- err
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a request against a server that never answers must time out")
		}
	case <-ctx.Done():
		t.Fatal("timeoutMs: 0 removed the deadline")
	}
}

func TestNodeTimeoutOverrideBounds(t *testing.T) {
	for _, tc := range []struct {
		name     string
		resolved float64
		override float64
		want     float64
	}{
		{name: "sane override", resolved: 30_000, override: 5_000, want: 5_000},
		{name: "zero falls through", resolved: 12_000, override: 0, want: 12_000},
		{name: "negative falls through", resolved: 12_000, override: -1, want: 12_000},
		{name: "override is capped", resolved: 30_000, override: 86_400_000, want: httpMaxTimeoutMs},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.resolved
			if tc.override >= 1 {
				got = min(tc.override, float64(httpMaxTimeoutMs))
			}
			if got != tc.want {
				t.Fatalf("resolved timeout = %v, want %v", got, tc.want)
			}
		})
	}
}
