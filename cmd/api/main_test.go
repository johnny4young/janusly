package main

import (
	"net/http"
	"strings"
	"testing"

	"github.com/johnny4young/janusly/internal/buildinfo"
)

func TestNewHTTPServerUsesBoundedListenerPolicy(t *testing.T) {
	handler := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	server := newHTTPServer("127.0.0.1:0", handler)

	if server.Addr != "127.0.0.1:0" || server.Handler == nil {
		t.Fatalf("server identity: addr=%q handler=%v", server.Addr, server.Handler)
	}
	if server.ReadHeaderTimeout != serverReadHeaderTimeout {
		t.Fatalf("ReadHeaderTimeout = %s", server.ReadHeaderTimeout)
	}
	if server.ReadTimeout != serverReadTimeout {
		t.Fatalf("ReadTimeout = %s", server.ReadTimeout)
	}
	if server.IdleTimeout != serverIdleTimeout {
		t.Fatalf("IdleTimeout = %s", server.IdleTimeout)
	}
	if server.MaxHeaderBytes != serverMaxHeaderBytes {
		t.Fatalf("MaxHeaderBytes = %d", server.MaxHeaderBytes)
	}
	if server.WriteTimeout != 0 {
		t.Fatalf("WriteTimeout must remain disabled for SSE, got %s", server.WriteTimeout)
	}
}

func TestRequireBuildProvenanceOnlyFailsClosedInProduction(t *testing.T) {
	development := buildinfo.Identity{SchemaVersion: buildinfo.SchemaVersion}
	if err := requireBuildProvenance(false, development); err != nil {
		t.Fatalf("development binary rejected: %v", err)
	}
	if err := requireBuildProvenance(true, development); err == nil ||
		!strings.Contains(err.Error(), "production requires verified build provenance") {
		t.Fatalf("production accepted an unverified binary: %v", err)
	}

	release := buildinfo.Identity{
		SchemaVersion:  buildinfo.SchemaVersion,
		Commit:         strings.Repeat("a", 40),
		Tree:           strings.Repeat("b", 40),
		ArtifactSHA256: strings.Repeat("c", 64),
		Verified:       true,
	}
	if err := requireBuildProvenance(true, release); err != nil {
		t.Fatalf("production rejected verified provenance: %v", err)
	}
}
