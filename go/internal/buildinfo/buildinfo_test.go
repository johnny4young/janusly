package buildinfo

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func withBuildIdentity(t *testing.T, commit, tree string) {
	t.Helper()
	oldCommit, oldTree := buildCommit, buildTree
	buildCommit, buildTree = commit, tree
	t.Cleanup(func() { buildCommit, buildTree = oldCommit, oldTree })
}

func TestFromExecutableHashesTheFinishedArtifact(t *testing.T) {
	commit, tree := strings.Repeat("a", 40), strings.Repeat("b", 40)
	withBuildIdentity(t, commit, tree)
	body := []byte("finished release artifact\n")
	path := filepath.Join(t.TempDir(), "janusly-go")
	if err := os.WriteFile(path, body, 0o700); err != nil {
		t.Fatal(err)
	}

	identity, err := fromExecutable(path)
	if err != nil {
		t.Fatalf("from executable: %v", err)
	}
	wantHash := fmt.Sprintf("%x", sha256.Sum256(body))
	if identity.SchemaVersion != SchemaVersion || identity.Commit != commit || identity.Tree != tree ||
		identity.ArtifactSHA256 != wantHash || !identity.Verified {
		t.Fatalf("unexpected identity: %+v", identity)
	}
	if err := identity.Validate(); err != nil {
		t.Fatalf("verified identity rejected: %v", err)
	}
}

func TestDevelopmentIdentityFailsClosed(t *testing.T) {
	withBuildIdentity(t, "development", "")
	path := filepath.Join(t.TempDir(), "janusly-go")
	if err := os.WriteFile(path, []byte("binary"), 0o700); err != nil {
		t.Fatal(err)
	}
	identity, err := fromExecutable(path)
	if err != nil {
		t.Fatalf("from executable: %v", err)
	}
	if identity.Verified {
		t.Fatalf("development identity must not verify: %+v", identity)
	}
	err = identity.Validate()
	if err == nil || !strings.Contains(err.Error(), "commit must be 40") ||
		!strings.Contains(err.Error(), "tree must be 40") ||
		!strings.Contains(err.Error(), "not verified") {
		t.Fatalf("expected bounded validation problems, got: %v", err)
	}
}

func TestFromExecutableRejectsUnreadablePath(t *testing.T) {
	withBuildIdentity(t, strings.Repeat("a", 40), strings.Repeat("b", 40))
	_, err := fromExecutable(filepath.Join(t.TempDir(), "missing"))
	if err == nil || !strings.Contains(err.Error(), "open running executable") {
		t.Fatalf("expected executable read failure, got: %v", err)
	}
}
