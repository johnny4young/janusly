package migrate

import (
	"io/fs"
	"regexp"
	"strings"
	"testing"
)

func TestEmbeddedMigrationIsSingleFreshBaseline(t *testing.T) {
	pattern := regexp.MustCompile(`^00001_baseline\.sql$`)
	entries, err := fs.ReadDir(migrations, "sql")
	if err != nil {
		t.Fatalf("read migrations: %v", err)
	}
	if len(entries) != 1 || !pattern.MatchString(entries[0].Name()) {
		t.Fatalf("expected only 00001_baseline.sql, got %v", entries)
	}
	raw, err := fs.ReadFile(migrations, "sql/00001_baseline.sql")
	if err != nil {
		t.Fatalf("read baseline: %v", err)
	}
	baseline := string(raw)
	if !strings.Contains(baseline, "+goose Up") || !strings.Contains(baseline, "+goose StatementBegin") {
		t.Fatal("baseline must contain Goose Up and StatementBegin markers")
	}
}

func TestBaselineContainsCurrentRuntimeObjectsOnly(t *testing.T) {
	raw, err := fs.ReadFile(migrations, "sql/00001_baseline.sql")
	if err != nil {
		t.Fatalf("read baseline: %v", err)
	}
	baseline := string(raw)
	for _, object := range []string{
		"rate_limit_windows",
		"run_start_idempotency",
		"run_wakeups",
		"run_wakeups_due_idx",
		"runs_org_created_id_idx",
		"schedule_entries_due_idx",
	} {
		if !strings.Contains(baseline, object) {
			t.Errorf("embedded baseline is missing current object %q", object)
		}
	}
	for _, obsolete := range []string{
		strings.Join([]string{"go", "pilot"}, "_"),
		"JANUSLY_" + "GO",
		"__drizzle_migrations",
		"CREATE SCHEMA drizzle",
	} {
		if strings.Contains(baseline, obsolete) {
			t.Errorf("embedded baseline contains unsupported object %q", obsolete)
		}
	}
}
