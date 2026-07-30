package httpapi

import (
	"io"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthzAnswersTruthfully(t *testing.T) {
	srv := httptest.NewServer(NewAPIHandler())
	defer srv.Close()

	res, err := srv.Client().Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatalf("healthz request: %v", err)
	}
	defer func() { _ = res.Body.Close() }()

	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || strings.TrimSpace(string(body)) != `{"ok":true}` {
		t.Fatalf("unexpected healthz response: %d %s", res.StatusCode, body)
	}
	if ct := res.Header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("unexpected content type: %s", ct)
	}
}

func TestMetricsExposeGoRuntime(t *testing.T) {
	srv := httptest.NewServer(NewInternalHandler())
	defer srv.Close()

	res, err := srv.Client().Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatalf("metrics request: %v", err)
	}
	defer func() { _ = res.Body.Close() }()

	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || !strings.Contains(string(body), "go_goroutines") {
		t.Fatalf("expected go_goroutines in metrics, got status %d", res.StatusCode)
	}
}

func TestPprofIndexIsServed(t *testing.T) {
	srv := httptest.NewServer(NewInternalHandler())
	defer srv.Close()

	res, err := srv.Client().Get(srv.URL + "/debug/pprof/")
	if err != nil {
		t.Fatalf("pprof request: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != 200 {
		t.Fatalf("unexpected pprof status: %d", res.StatusCode)
	}
}
