package httpapi

import (
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/buildinfo"
)

func testBuildIdentity() buildinfo.Identity {
	return buildinfo.Identity{
		SchemaVersion:  buildinfo.SchemaVersion,
		Commit:         strings.Repeat("a", 40),
		Tree:           strings.Repeat("b", 40),
		ArtifactSHA256: strings.Repeat("c", 64),
		Verified:       true,
	}
}

func TestMetricsExposeGoRuntime(t *testing.T) {
	srv := httptest.NewServer(NewInternalHandler(testBuildIdentity()))
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
	for _, metric := range []string{
		"janusly_feedback_memory_accepted_total",
		"janusly_feedback_memory_dropped_total",
		"janusly_feedback_memory_failures_total",
		"janusly_feedback_memory_active",
		"janusly_feedback_memory_queue_depth",
		"janusly_feedback_memory_duration_seconds",
	} {
		if !strings.Contains(string(body), metric) {
			t.Fatalf("expected %s in metrics", metric)
		}
	}
}

func TestPprofIndexIsServed(t *testing.T) {
	srv := httptest.NewServer(NewInternalHandler(testBuildIdentity()))
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

func TestInternalBuildIdentityIsMachineReadableAndUncached(t *testing.T) {
	want := testBuildIdentity()
	srv := httptest.NewServer(NewInternalHandler(want))
	defer srv.Close()

	res, err := srv.Client().Get(srv.URL + "/build")
	if err != nil {
		t.Fatalf("build identity request: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	var got buildinfo.Identity
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatalf("decode build identity: %v", err)
	}
	if res.StatusCode != 200 || got != want {
		t.Fatalf("unexpected build identity: status=%d got=%+v", res.StatusCode, got)
	}
	if res.Header.Get("Cache-Control") != "no-store" || res.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("unexpected build headers: %v", res.Header)
	}
}
