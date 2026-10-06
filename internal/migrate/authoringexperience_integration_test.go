//go:build integration

package migrate

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestAuthoringExperienceBaselineReferenceAndStorageBoundaries(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Minute)
	defer cancel()
	dsn := createMigrationTestDatabase(t)
	if err := Up(ctx, dsn); err != nil {
		t.Fatal(err)
	}
	if err := Up(ctx, dsn); err != nil {
		t.Fatal(err)
	}
	db, err := open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	var exists bool
	if err := db.QueryRowContext(ctx, `SELECT to_regclass('public.authoring_experiences') IS NOT NULL`).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if !exists {
		t.Fatal("authoring experience reference registry is missing from the sole baseline")
	}
	for _, stmt := range []string{
		`INSERT INTO workflows(id,org_id,name) VALUES ('wf-a','org-a','A'),('wf-b','org-b','B')`,
		`INSERT INTO workflow_versions(id,org_id,workflow_id,version,dag_json) VALUES ('ver-a','org-a','wf-a',1,'{"id":"wf-a","nodes":[],"edges":[]}'),('ver-b','org-b','wf-b',1,'{"id":"wf-b","nodes":[],"edges":[]}')`,
	} {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	insert := func(id, org, workflow, version, key, brief string) error {
		_, err := db.ExecContext(ctx, `INSERT INTO authoring_experiences
   (id,org_id,workflow_id,workflow_version_id,brief_key,brief_json,policy_version,registered_at,retain_until,created_by)
   VALUES ($1,$2,$3,$4,$5,$6::jsonb,'authoring-experience-v1',now(),now()+interval '1 day','operator')`, id, org, workflow, version, key, brief)
		return err
	}
	const brief = `{"version":"1","objective":"Prepare local text","trigger":"manual","inputs":[],"expectedOutcome":"Local text","externalEffects":[],"approvals":[],"failurePolicy":"stop_and_open_recovery_case","examples":[],"language":"en"}`
	key := strings.Repeat("a", 64)
	if err := insert("exp-a", "org-a", "wf-a", "ver-a", key, brief); err != nil {
		t.Fatalf("valid exact source rejected: %v", err)
	}
	for _, tc := range []struct{ name, org, workflow, version, key, brief string }{
		{"cross-tenant version", "org-a", "wf-a", "ver-b", key, brief},
		{"cross-tenant workflow", "org-a", "wf-b", "ver-b", key, brief},
		{"wrong workflow/version pair", "org-b", "wf-b", "ver-a", key, brief},
		{"unknown version", "org-a", "wf-a", "unknown", key, brief},
		{"unknown workflow", "org-a", "unknown", "ver-a", key, brief},
		{"invalid key", "org-a", "wf-a", "ver-a", "not-a-hash", brief},
		{"brief array", "org-a", "wf-a", "ver-a", strings.Repeat("b", 64), `[]`},
		{"oversized brief", "org-a", "wf-a", "ver-a", strings.Repeat("c", 64), `{"objective":"` + strings.Repeat("界", 8192) + `"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := insert("bad-"+tc.name, tc.org, tc.workflow, tc.version, tc.key, tc.brief); err == nil {
				t.Fatal("invalid registry row accepted")
			}
		})
	}
	// One active registration per exact artifact/key; revocation keeps the
	// historical row while allowing an explicit new registration identity.
	if err := insert("duplicate", "org-a", "wf-a", "ver-a", key, brief); err == nil {
		t.Fatal("duplicate active registration accepted")
	}
	if _, err := db.ExecContext(ctx, `UPDATE authoring_experiences SET revoked_at=now() WHERE id='exp-a'`); err != nil {
		t.Fatal(err)
	}
	if err := insert("re-registered", "org-a", "wf-a", "ver-a", key, brief); err != nil {
		t.Fatalf("explicit re-registration rejected: %v", err)
	}
	// The registry references canonical versions, not copied graphs. Physical
	// source retention cascades its references instead of breaking the sweep.
	if _, err := db.ExecContext(ctx, `DELETE FROM workflow_versions WHERE id='ver-a' AND org_id='org-a'`); err != nil {
		t.Fatalf("source retention blocked: %v", err)
	}
	var remaining int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM authoring_experiences`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("orphaned registrations remain: %d", remaining)
	}
}

func TestAuthoringExperienceRetentionBoundIgnoresSessionTimeZone(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Minute)
	defer cancel()
	dsn := createMigrationTestDatabase(t)
	if err := Up(ctx, dsn); err != nil {
		t.Fatal(err)
	}
	db, err := open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	conn, err := db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	// A DST session zone must not shorten the maximum 730 x 24 h deadline the
	// registry computes in UTC (standard time at registration, daylight time
	// at the deadline moves calendar-day arithmetic one hour earlier).
	for _, stmt := range []string{
		`SET TIME ZONE 'America/New_York'`,
		`INSERT INTO workflows(id,org_id,name) VALUES ('wf-tz','org-tz','TZ')`,
		`INSERT INTO workflow_versions(id,org_id,workflow_id,version,dag_json) VALUES ('ver-tz','org-tz','wf-tz',1,'{"id":"wf-tz","nodes":[],"edges":[]}')`,
	} {
		if _, err := conn.ExecContext(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	registered := time.Date(2026, time.November, 2, 12, 0, 0, 0, time.UTC)
	insert := func(id, key string, retainUntil time.Time) error {
		_, err := conn.ExecContext(ctx, `INSERT INTO authoring_experiences
   (id,org_id,workflow_id,workflow_version_id,brief_key,brief_json,policy_version,registered_at,retain_until,created_by)
   VALUES ($1,'org-tz','wf-tz','ver-tz',$2,'{}'::jsonb,'authoring-experience-v1',$3,$4,'operator')`, id, key, registered, retainUntil)
		return err
	}
	if err := insert("tz-max", strings.Repeat("d", 64), registered.AddDate(0, 0, 730)); err != nil {
		t.Fatalf("maximum UTC retention rejected under a DST session zone: %v", err)
	}
	if err := insert("tz-over", strings.Repeat("e", 64), registered.AddDate(0, 0, 730).Add(time.Second)); err == nil {
		t.Fatal("retention beyond 730 x 24 h accepted")
	}
}
