package migrate

import (
	"io/fs"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// T-532: the embedded migration set is the schema's source of truth —
// versions must be unique, contiguous from 1, and every file
// goose-shaped. A drifted or duplicated version breaks boot, so it
// breaks here first.
func TestEmbeddedMigrationsWellFormed(t *testing.T) {
	pattern := regexp.MustCompile(`^(\d{5})_[a-z0-9_-]+\.sql$`)
	versions := []int{}
	err := fs.WalkDir(migrations, "sql", func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		name := entry.Name()
		match := pattern.FindStringSubmatch(name)
		if match == nil {
			t.Fatalf("migration %q does not match NNNNN_name.sql", name)
		}
		version := 0
		for _, ch := range match[1] {
			version = version*10 + int(ch-'0')
		}
		versions = append(versions, version)
		raw, readErr := fs.ReadFile(migrations, path)
		if readErr != nil {
			t.Fatalf("read %s: %v", path, readErr)
		}
		if !strings.Contains(string(raw), "+goose Up") {
			t.Fatalf("%s is missing the goose Up marker", name)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	sort.Ints(versions)
	for i, version := range versions {
		if version != i+1 {
			t.Fatalf("versions must be contiguous from 1: %v", versions)
		}
	}
}
