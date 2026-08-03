package migrate

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/johnny4young/janusly/internal/cron"
)

const bridgeBatchSize = 256

type waitingBridgeRow struct {
	id     string
	kind   string
	target time.Time
}

func reconcileRuntimeBridge(ctx context.Context, db *sql.DB) error {
	if err := reconcileWaitingWakeups(ctx, db); err != nil {
		return err
	}
	var after time.Time
	if err := db.QueryRowContext(ctx, `SELECT clock_timestamp()`).Scan(&after); err != nil {
		return fmt.Errorf("read database clock for schedule bridge: %w", err)
	}
	return backfillScheduleDueClocks(ctx, db, after)
}

func reconcileWaitingWakeups(ctx context.Context, db *sql.DB) error {
	// A rollback-published Go retry is consumed by Node through the shared
	// queue-publication outbox. Node does not know the Go wakeup table, so its
	// terminal/running transition can leave that already-spent clock behind.
	// Preserve clocks only while they can still gate queued or waiting work.
	if _, err := db.ExecContext(ctx, `
		DELETE FROM go_pilot_wakeups w
		USING run_nodes rn
		WHERE w.run_node_id = rn.id
		  AND rn.status NOT IN ('queued', 'waiting')`); err != nil {
		return fmt.Errorf("clear spent runtime wakeups: %w", err)
	}

	// A due retry row inherited by an indefinite human checkpoint used to be
	// mistaken for a timer. Only the two bounded waiting kinds may own a wakeup.
	if _, err := db.ExecContext(ctx, `
		DELETE FROM go_pilot_wakeups w
		USING run_nodes rn
		WHERE w.run_node_id = rn.id
		  AND rn.status = 'waiting'
		  AND NOT (
			(rn.state_json #>> '{waiting,kind}' = 'timer'
			 AND COALESCE(rn.state_json #>> '{waiting,wakeAt}', '') <> '')
			OR
			(rn.state_json #>> '{waiting,kind}' = 'approval'
			 AND COALESCE(rn.state_json #>> '{waiting,deadlineAt}', '') <> ''
			 AND COALESCE(rn.state_json #>> '{waiting,timeoutState}', '') = '')
		  )`); err != nil {
		return fmt.Errorf("clear incompatible waiting wakeups: %w", err)
	}

	lastID := ""
	for {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("begin waiting-checkpoint bridge: %w", err)
		}
		rows, err := tx.QueryContext(ctx, `
			SELECT rn.id,
			       rn.state_json #>> '{waiting,kind}',
			       CASE
			         WHEN rn.state_json #>> '{waiting,kind}' = 'approval'
			           THEN COALESCE(rn.state_json #>> '{waiting,deadlineAt}', '')
			         ELSE COALESCE(rn.state_json #>> '{waiting,wakeAt}', '')
			       END
			FROM run_nodes rn
			WHERE rn.status = 'waiting'
			  AND rn.id > $1
			  AND (
			    rn.state_json #>> '{waiting,kind}' = 'timer'
			    OR (
			      rn.state_json #>> '{waiting,kind}' = 'approval'
			      AND COALESCE(rn.state_json #>> '{waiting,deadlineAt}', '') <> ''
			      AND COALESCE(rn.state_json #>> '{waiting,timeoutState}', '') = ''
			    )
			  )
			ORDER BY rn.id
			LIMIT $2
			FOR UPDATE OF rn`, lastID, bridgeBatchSize)
		if err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("select Node waiting checkpoints: %w", err)
		}
		batch := make([]waitingBridgeRow, 0, bridgeBatchSize)
		for rows.Next() {
			var id, kind, rawTarget string
			if err := rows.Scan(&id, &kind, &rawTarget); err != nil {
				_ = rows.Close()
				_ = tx.Rollback()
				return fmt.Errorf("scan Node waiting checkpoint: %w", err)
			}
			target, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(rawTarget))
			if err != nil {
				_ = rows.Close()
				_ = tx.Rollback()
				field := "wakeAt"
				if kind == "approval" {
					field = "deadlineAt"
				}
				return fmt.Errorf("waiting %s %q has invalid %s %q: %w", kind, id, field, rawTarget, err)
			}
			batch = append(batch, waitingBridgeRow{id: id, kind: kind, target: target.UTC()})
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			_ = tx.Rollback()
			return fmt.Errorf("iterate Node waiting checkpoints: %w", err)
		}
		if err := rows.Close(); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("close Node waiting checkpoints: %w", err)
		}
		for _, checkpoint := range batch {
			reason := "wait_until"
			if checkpoint.kind == "approval" {
				reason = "approval_timeout"
			}
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO go_pilot_wakeups (run_node_id, wake_at, reason)
				VALUES ($1, $2, $3)
				ON CONFLICT (run_node_id) DO UPDATE
				SET wake_at = EXCLUDED.wake_at, reason = EXCLUDED.reason`, checkpoint.id, checkpoint.target, reason); err != nil {
				_ = tx.Rollback()
				return fmt.Errorf("backfill waiting %s %q: %w", checkpoint.kind, checkpoint.id, err)
			}
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit waiting-checkpoint bridge: %w", err)
		}
		if len(batch) < bridgeBatchSize {
			return nil
		}
		lastID = batch[len(batch)-1].id
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
				SELECT 1 FROM go_pilot_wakeups w
				WHERE w.run_node_id = rn.id
				  AND w.reason = 'wait_until'
				  AND w.wake_at = (rn.state_json #>> '{waiting,wakeAt}')::timestamptz
			  )
		)`).Scan(&missingTimers); err != nil {
		return fmt.Errorf("inspect waiting timer bridge: %w", err)
	}
	if missingTimers {
		return errors.New("database runtime bridge is incomplete: waiting timers lack durable Go wakeups; rerun migrate")
	}

	var missingApprovals bool
	if err := db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM run_nodes rn
			WHERE rn.status = 'waiting'
			  AND rn.state_json #>> '{waiting,kind}' = 'approval'
			  AND COALESCE(rn.state_json #>> '{waiting,deadlineAt}', '') <> ''
			  AND COALESCE(rn.state_json #>> '{waiting,timeoutState}', '') = ''
			  AND NOT EXISTS (
				SELECT 1 FROM go_pilot_wakeups w
				WHERE w.run_node_id = rn.id
				  AND w.reason = 'approval_timeout'
				  AND w.wake_at = (rn.state_json #>> '{waiting,deadlineAt}')::timestamptz
			  )
		)`).Scan(&missingApprovals); err != nil {
		return fmt.Errorf("inspect waiting approval bridge: %w", err)
	}
	if missingApprovals {
		return errors.New("database runtime bridge is incomplete: waiting approvals lack durable Go deadline wakeups; rerun migrate")
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
