package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestInspectFileReturnsExactSizeAndSHA256(t *testing.T) {
	body := []byte("janusly artifact\n")
	path := filepath.Join(t.TempDir(), "janusly")
	if err := os.WriteFile(path, body, 0o755); err != nil {
		t.Fatal(err)
	}

	size, digest, err := inspectFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256(body)
	if size != int64(len(body)) || digest != hex.EncodeToString(want[:]) {
		t.Fatalf("inspectFile = (%d, %s), want (%d, %x)", size, digest, len(body), want)
	}
}

func TestWriteAtomicReplacesExistingManifest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeAtomic(path, []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "new\n" {
		t.Fatalf("manifest body = %q", body)
	}
}
