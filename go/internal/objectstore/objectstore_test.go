package objectstore

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// T-532: the provider ladder and the traversal defenses of the base
// module (the SigV4 driver has its own suite).

func TestSanitizeKeyRefusesTraversal(t *testing.T) {
	for _, hostile := range []string{"../../etc/passwd", "a/../../b", "..", "a/..\\/x"} {
		if got := sanitizeKey(hostile); strings.Contains(got, "..") {
			t.Fatalf("traversal survived: %q -> %q", hostile, got)
		}
	}
	if got := sanitizeKey("org-1/pdf/doc.pdf"); got != "org-1/pdf/doc.pdf" {
		t.Fatalf("clean key mangled: %q", got)
	}
}

func TestProviderLadder(t *testing.T) {
	t.Setenv("JANUSLY_OBJECT_STORE_PROVIDER", "")
	t.Setenv("JANUSLY_OBJECT_STORE_BUCKET", "")
	t.Setenv("JANUSLY_OBJECT_STORE_LOCAL_DIR", "")
	// Unconfigured → noop with the honest envelope.
	if result := Put("", "k.pdf", []byte("x"), ""); result.Ok || result.Provider != "noop" {
		t.Fatalf("noop default: %+v", result)
	}
	// s3 requested WITHOUT a bucket → still noop (the ladder requires both).
	t.Setenv("JANUSLY_OBJECT_STORE_PROVIDER", "s3")
	if result := Put("", "k.pdf", []byte("x"), ""); result.Provider != "noop" {
		t.Fatalf("s3 without bucket must stay noop: %+v", result)
	}
	// Local round-trip + escape defense.
	root := t.TempDir()
	t.Setenv("JANUSLY_OBJECT_STORE_PROVIDER", "local")
	t.Setenv("JANUSLY_OBJECT_STORE_LOCAL_DIR", root)
	result := Put("", "org/doc.pdf", []byte("payload"), "application/pdf")
	if !result.Ok || result.Provider != "local" {
		t.Fatalf("local put: %+v", result)
	}
	written, err := os.ReadFile(filepath.Join(root, "org", "doc.pdf"))
	if err != nil || string(written) != "payload" {
		t.Fatalf("local read-back: %v %q", err, written)
	}
	// Empty body / hostile key degrade, never write.
	if result := Put("", "", []byte("x"), ""); result.Ok {
		t.Fatalf("empty key must degrade: %+v", result)
	}
	if result := Put("", "k.pdf", nil, ""); result.Ok {
		t.Fatalf("empty body must degrade: %+v", result)
	}
}
