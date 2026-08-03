package migrate

import (
	"io/fs"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The embedded migration set is the schema's source of truth. Versions must
// be unique and contiguous from 1, and every file must be goose-shaped. A
// drifted or duplicated version breaks boot, so it breaks here first.
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

func TestBaselineContainsPilotBootstrapObjects(t *testing.T) {
	raw, err := fs.ReadFile(migrations, "sql/00001_baseline.sql")
	if err != nil {
		t.Fatalf("read baseline: %v", err)
	}
	baseline := string(raw)
	for _, object := range []string{
		"go_pilot_wakeups",
		"go_pilot_start_idempotency",
		"go_pilot_runs_org_created_id_idx",
	} {
		if !strings.Contains(baseline, object) {
			t.Errorf("embedded baseline is missing legacy pilot object %q", object)
		}
	}
}

func TestNodeRuntimeBridgeRecreatesStampedObjects(t *testing.T) {
	raw, err := fs.ReadFile(migrations, "sql/00007_node_runtime_bridge.sql")
	if err != nil {
		t.Fatalf("read Node runtime bridge: %v", err)
	}
	bridge := string(raw)
	for _, fragment := range []string{
		"CREATE TABLE IF NOT EXISTS go_pilot_start_idempotency",
		"CREATE TABLE IF NOT EXISTS go_pilot_wakeups",
		"CREATE INDEX IF NOT EXISTS go_pilot_wakeups_due_idx",
		"DROP INDEX IF EXISTS go_pilot_runs_org_created_id_idx",
	} {
		if !strings.Contains(bridge, fragment) {
			t.Errorf("Node runtime bridge is missing %q", fragment)
		}
	}
}
