package migrate

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/johnny4young/janusly/go/internal/cron"
)

const bridgeBatchSize = 256

// AssertWorkPlaneReady rejects durable Node states that this Go runtime cannot
// continue safely. Passive read/shadow processes deliberately do not call this
// gate; every active API/MCP process does before starting a worker or mutation
// loop. New Go approvals with deadline policy already fail at their executor,
// so the query covers legacy Node checkpoints and saved workflows.
func AssertWorkPlaneReady(ctx context.Context, databaseURL string) error {
	db, err := open(databaseURL)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()

	var runNodeID string
	err = db.QueryRowContext(ctx, `
		SELECT id
		FROM run_nodes
		WHERE status = 'waiting'
		  AND state_json #>> '{waiting,kind}' = 'approval'
		  AND COALESCE(state_json #>> '{waiting,deadlineAt}', '') <> ''
		  AND COALESCE(state_json #>> '{waiting,timeoutState}', '') = ''
		ORDER BY id
		LIMIT 1`).Scan(&runNodeID)
	if err == nil {
		return fmt.Errorf("work plane is not ready for Go: waiting approval %q has an unresolved Node deadline", runNodeID)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("inspect waiting approval deadlines: %w", err)
	}

	var workflowID, nodeID string
	err = db.QueryRowContext(ctx, `
		SELECT w.id, node ->> 'id'
		FROM workflows w
		JOIN LATERAL (
			SELECT dag_json
			FROM workflow_versions
			WHERE workflow_id = w.id AND org_id = w.org_id
			ORDER BY version DESC
			LIMIT 1
		) latest ON true
		CROSS JOIN LATERAL jsonb_array_elements(COALESCE(latest.dag_json -> 'nodes', '[]'::jsonb)) node
		WHERE w.deleted_at IS NULL
		  AND node ->> 'type' = 'approval'
		  AND COALESCE(node -> 'config', '{}'::jsonb) ?| ARRAY['decisionTimeoutMs', 'until', 'onTimeout', 'escalateTo']
		ORDER BY w.id, node ->> 'id'
		LIMIT 1`).Scan(&workflowID, &nodeID)
	if err == nil {
		return fmt.Errorf("work plane is not ready for Go: workflow %q approval %q uses unsupported deadline policy", workflowID, nodeID)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("inspect saved approval deadline policy: %w", err)
	}
	return nil
}

type timerBridgeRow struct {
	id     string
	wakeAt time.Time
}

func reconcileRuntimeBridge(ctx context.Context, db *sql.DB) error {
	if err := backfillTimerWakeups(ctx, db); err != nil {
		return err
	}
	var after time.Time
	if err := db.QueryRowContext(ctx, `SELECT clock_timestamp()`).Scan(&after); err != nil {
		return fmt.Errorf("read database clock for schedule bridge: %w", err)
	}
	return backfillScheduleDueClocks(ctx, db, after)
}

func backfillTimerWakeups(ctx context.Context, db *sql.DB) error {
	for {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("begin timer bridge: %w", err)
		}
		rows, err := tx.QueryContext(ctx, `
			SELECT rn.id, COALESCE(rn.state_json #>> '{waiting,wakeAt}', '')
			FROM run_nodes rn
			WHERE rn.status = 'waiting'
			  AND rn.state_json #>> '{waiting,kind}' = 'timer'
			  AND NOT EXISTS (
				SELECT 1 FROM go_pilot_wakeups w WHERE w.run_node_id = rn.id
			  )
			ORDER BY rn.id
			LIMIT $1
			FOR UPDATE OF rn`, bridgeBatchSize)
		if err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("select Node timer checkpoints: %w", err)
		}
		batch := make([]timerBridgeRow, 0, bridgeBatchSize)
		for rows.Next() {
			var id, rawWakeAt string
			if err := rows.Scan(&id, &rawWakeAt); err != nil {
				_ = rows.Close()
				_ = tx.Rollback()
				return fmt.Errorf("scan Node timer checkpoint: %w", err)
			}
			wakeAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(rawWakeAt))
			if err != nil {
				_ = rows.Close()
				_ = tx.Rollback()
				return fmt.Errorf("waiting timer %q has invalid wakeAt %q: %w", id, rawWakeAt, err)
			}
			batch = append(batch, timerBridgeRow{id: id, wakeAt: wakeAt.UTC()})
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			_ = tx.Rollback()
			return fmt.Errorf("iterate Node timer checkpoints: %w", err)
		}
		if err := rows.Close(); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("close Node timer checkpoints: %w", err)
		}
		for _, timer := range batch {
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO go_pilot_wakeups (run_node_id, wake_at, reason)
				VALUES ($1, $2, 'wait_until')
				ON CONFLICT (run_node_id) DO NOTHING`, timer.id, timer.wakeAt); err != nil {
				_ = tx.Rollback()
				return fmt.Errorf("backfill waiting timer %q: %w", timer.id, err)
			}
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit timer bridge: %w", err)
		}
		if len(batch) < bridgeBatchSize {
			return nil
		}
	}
}

type scheduleBridgeRow struct {
	id       string
	nextFire time.Time
}

func backfillScheduleDueClocks(ctx context.Context, db *sql.DB, after time.Time) error {
	for {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("begin schedule bridge: %w", err)
		}
		rows, err := tx.QueryContext(ctx, `
			SELECT id, cron_expression
			FROM schedule_entries
			WHERE enabled AND next_fire_at IS NULL
			ORDER BY id
			LIMIT $1
			FOR UPDATE`, bridgeBatchSize)
		if err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("select Node schedules: %w", err)
		}
		batch := make([]scheduleBridgeRow, 0, bridgeBatchSize)
		for rows.Next() {
			var id, expression string
			if err := rows.Scan(&id, &expression); err != nil {
				_ = rows.Close()
				_ = tx.Rollback()
				return fmt.Errorf("scan Node schedule: %w", err)
			}
			schedule, err := cron.Parse(expression)
			if err != nil {
				_ = rows.Close()
				_ = tx.Rollback()
				return fmt.Errorf("schedule %q has invalid cron expression %q: %w", id, expression, err)
			}
			nextFire, err := schedule.Next(after)
			if err != nil {
				_ = rows.Close()
				_ = tx.Rollback()
				return fmt.Errorf("schedule %q cannot compute its next fire from %q: %w", id, expression, err)
			}
			batch = append(batch, scheduleBridgeRow{id: id, nextFire: nextFire})
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			_ = tx.Rollback()
			return fmt.Errorf("iterate Node schedules: %w", err)
		}
		if err := rows.Close(); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("close Node schedules: %w", err)
		}
		for _, entry := range batch {
			if _, err := tx.ExecContext(ctx, `
				UPDATE schedule_entries
				SET next_fire_at = $2
				WHERE id = $1 AND enabled AND next_fire_at IS NULL`, entry.id, entry.nextFire); err != nil {
				_ = tx.Rollback()
				return fmt.Errorf("backfill schedule %q: %w", entry.id, err)
			}
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit schedule bridge: %w", err)
		}
		if len(batch) < bridgeBatchSize {
			return nil
		}
	}
}

func assertRuntimeBridge(ctx context.Context, db *sql.DB) error {
	for _, relation := range []string{
		"public.go_pilot_start_idempotency",
		"public.go_pilot_wakeups",
	} {
		var found sql.NullString
		if err := db.QueryRowContext(ctx, `SELECT to_regclass($1)`, relation).Scan(&found); err != nil {
			return fmt.Errorf("inspect runtime bridge relation %s: %w", relation, err)
		}
		if !found.Valid {
			return fmt.Errorf("database runtime bridge is incomplete: relation %s is missing; rerun migrate", relation)
		}
	}
	requiredColumns := []struct {
		relation string
		columns  []string
	}{
		{"go_pilot_start_idempotency", []string{"org_id", "idempotency_key", "run_id", "created_at"}},
		{"go_pilot_wakeups", []string{"run_node_id", "wake_at", "reason"}},
	}
	for _, requirement := range requiredColumns {
		for _, column := range requirement.columns {
			var exists bool
			if err := db.QueryRowContext(ctx, `
				SELECT EXISTS (
					SELECT 1 FROM information_schema.columns
					WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
				)`, requirement.relation, column).Scan(&exists); err != nil {
				return fmt.Errorf("inspect runtime bridge column %s.%s: %w", requirement.relation, column, err)
			}
			if !exists {
				return fmt.Errorf("database runtime bridge is incomplete: column public.%s.%s is missing; rerun migrate", requirement.relation, column)
			}
		}
	}
	var dueClockExists bool
	if err := db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = 'schedule_entries' AND column_name = 'next_fire_at'
		)`).Scan(&dueClockExists); err != nil {
		return fmt.Errorf("inspect schedule due clock: %w", err)
	}
	if !dueClockExists {
		return errors.New("database runtime bridge is incomplete: schedule_entries.next_fire_at is missing; rerun migrate")
	}

	var missingTimers bool
	if err := db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM run_nodes rn
			WHERE rn.status = 'waiting'
			  AND rn.state_json #>> '{waiting,kind}' = 'timer'
			  AND NOT EXISTS (
				SELECT 1 FROM go_pilot_wakeups w WHERE w.run_node_id = rn.id
			  )
		)`).Scan(&missingTimers); err != nil {
		return fmt.Errorf("inspect waiting timer bridge: %w", err)
	}
	if missingTimers {
		return errors.New("database runtime bridge is incomplete: waiting timers lack durable Go wakeups; rerun migrate")
	}

	var missingScheduleClocks bool
	if err := db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM schedule_entries WHERE enabled AND next_fire_at IS NULL
		)`).Scan(&missingScheduleClocks); err != nil {
		return fmt.Errorf("inspect schedule due-clock bridge: %w", err)
	}
	if missingScheduleClocks {
		return errors.New("database runtime bridge is incomplete: enabled schedules lack next_fire_at; rerun migrate")
	}
	return nil
}
