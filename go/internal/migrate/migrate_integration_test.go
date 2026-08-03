//go:build integration

package migrate

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/pressly/goose/v3"
)

func migrationDatabaseURL(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("JANUSLY_GO_DATABASE_URL")
	if dsn == "" {
		t.Skip("JANUSLY_GO_DATABASE_URL not set; run through make test")
	}
	return dsn
}

func createMigrationTestDatabase(t *testing.T) string {
	t.Helper()
	parsed, err := url.Parse(migrationDatabaseURL(t))
	if err != nil {
		t.Fatalf("parse integration database URL: %v", err)
	}
	adminURL := *parsed
	adminURL.Path = "/postgres"
	admin, err := open(adminURL.String())
	if err != nil {
		t.Fatalf("open PostgreSQL maintenance database: %v", err)
	}
	defer func() { _ = admin.Close() }()

	name := fmt.Sprintf("janusly_migrate_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(context.Background(),
		`CREATE DATABASE "`+name+`" TEMPLATE template0`); err != nil {
		t.Fatalf("create isolated migration database: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cleanup, openErr := open(adminURL.String())
		if openErr != nil {
			t.Errorf("open maintenance database for cleanup: %v", openErr)
			return
		}
		defer func() { _ = cleanup.Close() }()
		if _, dropErr := cleanup.ExecContext(ctx,
			`DROP DATABASE IF EXISTS "`+name+`" WITH (FORCE)`); dropErr != nil {
			t.Errorf("drop isolated migration database: %v", dropErr)
		}
	})

	targetURL := *parsed
	targetURL.Path = "/" + name
	return targetURL.String()
}

func prepareNodeRuntimeDatabase(t *testing.T, ctx context.Context, dsn string) {
	t.Helper()
	configure()
	db, err := open(dsn)
	if err != nil {
		t.Fatalf("open isolated migration database: %v", err)
	}
	defer func() { _ = db.Close() }()
	if err := goose.UpToContext(ctx, db, "sql", baselineVersion); err != nil {
		t.Fatalf("apply captured shared baseline: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		DROP INDEX IF EXISTS go_pilot_runs_org_created_id_idx;
		DROP TABLE go_pilot_start_idempotency;
		DROP TABLE go_pilot_wakeups;
		ALTER TABLE schedule_entries DROP COLUMN IF EXISTS next_fire_at;
		DROP TABLE go_pilot_goose_version;
		CREATE TABLE go_pilot_goose_version (
			id serial PRIMARY KEY,
			version_id bigint NOT NULL,
			is_applied boolean NOT NULL,
			tstamp timestamp NOT NULL DEFAULT now()
		);
		INSERT INTO go_pilot_goose_version (version_id, is_applied) VALUES (0, true);

		INSERT INTO schedule_entries (
			id, org_id, workflow_id, workflow_version_id, node_id, cron_expression, enabled
		) VALUES
			('enabled-schedule', 'org-1', 'workflow-schedule', 'version-schedule', 'cron', '* * * * *', true),
			('disabled-schedule', 'org-1', 'workflow-schedule', 'version-schedule', 'cron-off', '* * * * *', false);

		INSERT INTO run_nodes (id, run_id, node_id, status, state_json) VALUES
			('timer-node', 'run-timer', 'wait', 'waiting',
			 '{"waiting":{"kind":"timer","wakeAt":"2026-08-03T12:34:56.789Z"}}'::jsonb),
			('approval-node', 'run-approval', 'gate', 'waiting',
			 '{"waiting":{"kind":"approval","deadlineAt":"2026-08-03T13:00:00.000Z","onTimeout":"fail"}}'::jsonb);

		INSERT INTO workflows (id, org_id, name, status)
		VALUES ('workflow-approval', 'org-1', 'Deadline approval', 'active');
		INSERT INTO workflow_versions (id, org_id, workflow_id, version, dag_json)
		VALUES (
			'version-approval', 'org-1', 'workflow-approval', 1,
			'{"nodes":[{"id":"gate","type":"approval","config":{"decisionTimeoutMs":60000,"onTimeout":"fail"}}],"edges":[]}'::jsonb
		);
	`); err != nil {
		t.Fatalf("shape captured baseline as a pre-Goose Node database: %v", err)
	}
}

func TestUpgradePreGooseNodeRuntimeDatabase(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	dsn := createMigrationTestDatabase(t)
	prepareNodeRuntimeDatabase(t, ctx, dsn)

	if err := Up(ctx, dsn); err != nil {
		t.Fatalf("upgrade pre-Goose Node database: %v", err)
	}
	if err := AssertMigrated(ctx, dsn); err != nil {
		t.Fatalf("upgraded database must pass the boot gate: %v", err)
	}

	db, err := open(dsn)
	if err != nil {
		t.Fatalf("open upgraded database: %v", err)
	}
	defer func() { _ = db.Close() }()

	latest, err := latestEmbeddedVersion()
	if err != nil {
		t.Fatalf("latest embedded version: %v", err)
	}
	var current int64
	if err := db.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(version_id) FILTER (WHERE is_applied), 0) FROM go_pilot_goose_version`).Scan(&current); err != nil {
		t.Fatalf("read migrated version: %v", err)
	}
	if current != latest {
		t.Fatalf("migration version = %d, want %d", current, latest)
	}

	var timerWakeAt time.Time
	var timerReason string
	if err := db.QueryRowContext(ctx,
		`SELECT wake_at, reason FROM go_pilot_wakeups WHERE run_node_id = 'timer-node'`).
		Scan(&timerWakeAt, &timerReason); err != nil {
		t.Fatalf("read bridged timer: %v", err)
	}
	expectedWakeAt := time.Date(2026, 8, 3, 12, 34, 56, 789_000_000, time.UTC)
	if !timerWakeAt.Equal(expectedWakeAt) || timerReason != "wait_until" {
		t.Fatalf("timer bridge = (%s, %q), want (%s, wait_until)", timerWakeAt, timerReason, expectedWakeAt)
	}

	var enabledNext, disabledNext sql.NullTime
	if err := db.QueryRowContext(ctx,
		`SELECT next_fire_at FROM schedule_entries WHERE id = 'enabled-schedule'`).Scan(&enabledNext); err != nil {
		t.Fatalf("read enabled schedule due clock: %v", err)
	}
	if !enabledNext.Valid || enabledNext.Time.Second() != 0 || enabledNext.Time.Nanosecond() != 0 {
		t.Fatalf("enabled schedule next_fire_at must be a minute-aligned instant, got %v", enabledNext)
	}
	if err := db.QueryRowContext(ctx,
		`SELECT next_fire_at FROM schedule_entries WHERE id = 'disabled-schedule'`).Scan(&disabledNext); err != nil {
		t.Fatalf("read disabled schedule due clock: %v", err)
	}
	if disabledNext.Valid {
		t.Fatalf("disabled schedule must remain unarmed, got %s", disabledNext.Time)
	}

	firstNext := enabledNext.Time
	if err := Up(ctx, dsn); err != nil {
		t.Fatalf("repeat migration idempotently: %v", err)
	}
	if err := db.QueryRowContext(ctx,
		`SELECT next_fire_at FROM schedule_entries WHERE id = 'enabled-schedule'`).Scan(&enabledNext); err != nil {
		t.Fatalf("reread enabled schedule due clock: %v", err)
	}
	if !enabledNext.Time.Equal(firstNext) {
		t.Fatalf("idempotent migration moved due clock from %s to %s", firstNext, enabledNext.Time)
	}

	err = AssertWorkPlaneReady(ctx, dsn)
	if err == nil || !strings.Contains(err.Error(), "waiting approval \"approval-node\"") {
		t.Fatalf("unresolved Node approval deadline must block active Go: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE run_nodes
		SET state_json = jsonb_set(state_json, '{waiting,timeoutState}', '"escalated"'::jsonb)
		WHERE id = 'approval-node'
	`); err != nil {
		t.Fatalf("mark legacy approval deadline handled: %v", err)
	}
	err = AssertWorkPlaneReady(ctx, dsn)
	if err == nil || !strings.Contains(err.Error(), "workflow \"workflow-approval\" approval \"gate\"") {
		t.Fatalf("saved unsupported approval policy must block active Go: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO workflow_versions (id, org_id, workflow_id, version, dag_json)
		VALUES (
			'version-approval-safe', 'org-1', 'workflow-approval', 2,
			'{"nodes":[{"id":"gate","type":"approval","config":{}}],"edges":[]}'::jsonb
		)
	`); err != nil {
		t.Fatalf("publish compatible latest workflow version: %v", err)
	}
	if err := AssertWorkPlaneReady(ctx, dsn); err != nil {
		t.Fatalf("resolved checkpoints and compatible latest workflows must be ready: %v", err)
	}

	if _, err := db.ExecContext(ctx, `
		INSERT INTO run_nodes (id, run_id, node_id, status, state_json)
		VALUES ('invalid-timer', 'run-invalid', 'wait', 'waiting',
			'{"waiting":{"kind":"timer","wakeAt":"not-an-instant"}}'::jsonb)
	`); err != nil {
		t.Fatalf("insert malformed legacy timer: %v", err)
	}
	if err := AssertMigrated(ctx, dsn); err == nil ||
		!strings.Contains(err.Error(), "waiting timers lack durable Go wakeups") {
		t.Fatalf("missing timer wakeup must fail boot readiness: %v", err)
	}
	if err := Up(ctx, dsn); err == nil ||
		!strings.Contains(err.Error(), "waiting timer \"invalid-timer\" has invalid wakeAt") {
		t.Fatalf("malformed timer must fail migration explicitly: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE run_nodes
		SET state_json = '{"waiting":{"kind":"timer","wakeAt":"2026-08-04T00:00:00Z"}}'::jsonb
		WHERE id = 'invalid-timer'
	`); err != nil {
		t.Fatalf("repair malformed legacy timer: %v", err)
	}
	if err := Up(ctx, dsn); err != nil {
		t.Fatalf("retry migration after repairing timer: %v", err)
	}

	if _, err := db.ExecContext(ctx,
		`UPDATE schedule_entries SET next_fire_at = NULL WHERE id = 'enabled-schedule'`); err != nil {
		t.Fatalf("remove due clock for readiness test: %v", err)
	}
	if err := AssertMigrated(ctx, dsn); err == nil ||
		!strings.Contains(err.Error(), "enabled schedules lack next_fire_at") {
		t.Fatalf("missing due clock must fail boot readiness: %v", err)
	}
	if err := Up(ctx, dsn); err != nil {
		t.Fatalf("retry migration must repair missing due clock: %v", err)
	}
	if err := AssertMigrated(ctx, dsn); err != nil {
		t.Fatalf("repaired database must pass the boot gate: %v", err)
	}

	if _, err := db.ExecContext(ctx, `
		INSERT INTO go_pilot_goose_version (version_id, is_applied)
		VALUES ($1, true)`, latest+1); err != nil {
		t.Fatalf("simulate a database newer than the binary: %v", err)
	}
	if err := AssertMigrated(ctx, dsn); err == nil ||
		!strings.Contains(err.Error(), fmt.Sprintf("database is at migration %d but the binary embeds %d", latest+1, latest)) {
		t.Fatalf("older binary must reject a newer database: %v", err)
	}
}
