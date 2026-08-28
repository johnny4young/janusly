package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestOperationalHealthHandlers(t *testing.T) {
	t.Run("liveness is independent of dependencies", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		healthzHandler(recorder, httptest.NewRequest(http.MethodGet, "/healthz", nil))
		assertOperationalResponse(t, recorder, http.StatusOK, `{"ok":true}`)
	})

	tests := []struct {
		name   string
		probe  readinessProbe
		status int
		body   string
	}{
		{
			name:   "ready",
			probe:  func(context.Context) error { return nil },
			status: http.StatusOK,
			body:   `{"ok":true}`,
		},
		{
			name:   "dependency failure stays opaque",
			probe:  func(context.Context) error { return errors.New("postgres secret topology") },
			status: http.StatusServiceUnavailable,
			body:   `{"ok":false}`,
		},
		{
			name:   "missing probe fails closed",
			probe:  nil,
			status: http.StatusServiceUnavailable,
			body:   `{"ok":false}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			readyzHandler(time.Second, tt.probe)(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
			assertOperationalResponse(t, recorder, tt.status, tt.body)
		})
	}
}

func TestReadinessTimesOut(t *testing.T) {
	recorder := httptest.NewRecorder()
	probe := func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	}
	started := time.Now()
	readyzHandler(10*time.Millisecond, probe)(recorder, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if elapsed := time.Since(started); elapsed > 250*time.Millisecond {
		t.Fatalf("readiness timeout took %s", elapsed)
	}
	assertOperationalResponse(t, recorder, http.StatusServiceUnavailable, `{"ok":false}`)
}

func assertOperationalResponse(t *testing.T, recorder *httptest.ResponseRecorder, status int, body string) {
	t.Helper()
	if recorder.Code != status || recorder.Body.String() != body {
		t.Fatalf("response = %d %q, want %d %q", recorder.Code, recorder.Body.String(), status, body)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("content-type = %q", got)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("cache-control = %q", got)
	}
}
