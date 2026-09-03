package objectstore

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The provider ladder and the traversal defenses of the base
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
	if result := Put(t.Context(), "", "k.pdf", []byte("x"), ""); result.Ok || result.Provider != "noop" {
		t.Fatalf("noop default: %+v", result)
	}
	// s3 requested WITHOUT a bucket → still noop (the ladder requires both).
	t.Setenv("JANUSLY_OBJECT_STORE_PROVIDER", "s3")
	if result := Put(t.Context(), "", "k.pdf", []byte("x"), ""); result.Provider != "noop" {
		t.Fatalf("s3 without bucket must stay noop: %+v", result)
	}
	// Local round-trip + escape defense.
	root := t.TempDir()
	t.Setenv("JANUSLY_OBJECT_STORE_PROVIDER", "local")
	t.Setenv("JANUSLY_OBJECT_STORE_LOCAL_DIR", root)
	result := Put(t.Context(), "", "org/doc.pdf", []byte("payload"), "application/pdf")
	if !result.Ok || result.Provider != "local" {
		t.Fatalf("local put: %+v", result)
	}
	written, err := os.ReadFile(filepath.Join(root, "org", "doc.pdf"))
	if err != nil || string(written) != "payload" {
		t.Fatalf("local read-back: %v %q", err, written)
	}
	if read := Get(t.Context(), "", "org/doc.pdf", 64); !read.Ok || string(read.Body) != "payload" {
		t.Fatalf("local get: %+v", read)
	}
	if read := Get(t.Context(), "", "org/doc.pdf", 3); read.Ok || read.Error != "object exceeds the read limit" {
		t.Fatalf("bounded local get: %+v", read)
	}
	// Empty body / hostile key degrade, never write.
	if result := Put(t.Context(), "", "", []byte("x"), ""); result.Ok {
		t.Fatalf("empty key must degrade: %+v", result)
	}
	if result := Put(t.Context(), "", "k.pdf", nil, ""); result.Ok {
		t.Fatalf("empty body must degrade: %+v", result)
	}
}

func TestLocalStoreRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	t.Setenv("JANUSLY_OBJECT_STORE_PROVIDER", "local")
	t.Setenv("JANUSLY_OBJECT_STORE_LOCAL_DIR", root)
	if result := Put(t.Context(), "", "escape/payload.txt", []byte("secret"), "text/plain"); result.Ok {
		t.Fatalf("symlinked parent must not escape local root: %+v", result)
	}
	if _, err := os.Stat(filepath.Join(outside, "payload.txt")); !os.IsNotExist(err) {
		t.Fatal("escaped object must not be written")
	}
	if err := os.WriteFile(filepath.Join(outside, "existing.txt"), []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if read := Get(t.Context(), "", "escape/existing.txt", 64); read.Ok {
		t.Fatalf("symlinked source must not escape local root: %+v", read)
	}
}
