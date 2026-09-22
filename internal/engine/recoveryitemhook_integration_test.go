//go:build integration

package engine

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/johnny4young/janusly/internal/store"
)

func TestRecoveryItemHookUsesOnlyCompletionConnection(t *testing.T) {
	ctx, pool, setup, org := newHarness(t)
	runID, err := setup.StartRun(ctx, StartInput{
		OrgID: org, Workflow: mustParse(t, `{"id":"hook-one-connection","nodes":[{"id":"fail","type":"noop","config":{}}],"edges":[]}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	var rowID string
	if err := pool.QueryRow(ctx, `UPDATE run_nodes SET status = 'running' WHERE run_id = $1 RETURNING id`, runID).Scan(&rowID); err != nil {
		t.Fatal(err)
	}
	config := pool.Config()
	config.MaxConns = 1
	config.MinConns = 0
	completionPool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(completionPool.Close)
	completionCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	eng := New(completionPool)
	if err := eng.FailNode(completionCtx, ClaimedNode{
		RowID: rowID, RunID: runID, NodeID: "fail", OrgID: org, Attempt: 1,
	}, errors.New("synthetic failure")); err != nil {
		t.Fatalf("completion must not acquire another pool connection: %v", err)
	}
	var failures, items, receipts int
	for query, count := range map[string]*int{
		`SELECT count(*) FROM dead_letters WHERE org_id = $1`:                                    &failures,
		`SELECT count(*) FROM recovery_items WHERE org_id = $1`:                                  &items,
		`SELECT count(*) FROM audit_logs WHERE org_id = $1 AND action = 'recovery.item.created'`: &receipts,
	} {
		if err := pool.QueryRow(ctx, query, org).Scan(count); err != nil {
			t.Fatal(err)
		}
	}
	if failures != 1 || items != 1 || receipts != 1 {
		t.Fatalf("atomic completion: dead letters=%d items=%d audit=%d", failures, items, receipts)
	}
}

// A real SQL failure aborts PostgreSQL's transaction until ROLLBACK TO;
// returning a Go error alone would not exercise this failure mode.
type recoveryHookFault struct {
	store.DBTX
	match string
	hits  *int
}

func (f *recoveryHookFault) statement(sql string, args []any) (string, []any) {
	if strings.Contains(sql, f.match) {
		(*f.hits)++
		return "SELECT 1/0", nil
	}
	return sql, args
}

func (f *recoveryHookFault) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	sql, args = f.statement(sql, args)
	return f.DBTX.Exec(ctx, sql, args...)
}

func (f *recoveryHookFault) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	sql, args = f.statement(sql, args)
	return f.DBTX.Query(ctx, sql, args...)
}

func (f *recoveryHookFault) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	sql, args = f.statement(sql, args)
	return f.DBTX.QueryRow(ctx, sql, args...)
}

func recoveryHookClaim(t *testing.T, ctx context.Context, pool *pgxpool.Pool, eng *Engine, org string) ClaimedNode {
	t.Helper()
	runID, err := eng.StartRun(ctx, StartInput{
		OrgID: org, Workflow: mustParse(t, `{"id":"hook-failure","nodes":[{"id":"fail","type":"noop","config":{}}],"edges":[]}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	var rowID string
	if err := pool.QueryRow(ctx, `UPDATE run_nodes SET status = 'running' WHERE run_id = $1 RETURNING id`, runID).Scan(&rowID); err != nil {
		t.Fatal(err)
	}
	return ClaimedNode{RowID: rowID, RunID: runID, NodeID: "fail", OrgID: org, Attempt: 1}
}

func assertRecoveryHookCounts(t *testing.T, ctx context.Context, pool *pgxpool.Pool, org string, failures, items, receipts int) {
	t.Helper()
	for _, check := range []struct {
		table string
		want  int
	}{
		{"dead_letters", failures}, {"recovery_items", items}, {"audit_logs", receipts},
	} {
		var got int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM "+check.table+" WHERE org_id = $1", org).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != check.want {
			t.Errorf("%s: got %d, want %d", check.table, got, check.want)
		}
	}
}

func TestRecoveryItemHookSQLFailureBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name, match               string
		wantError                 bool
		failures, items, receipts int
	}{
		{"config falls back", "name: ListOrgConfigRows", false, 1, 1, 1},
		{"debounce lookup", "name: FindOpenRecoveryItemForDebounce", false, 1, 0, 0},
		{"severity lookup", "name: GetWorkflowSeverityDefault", false, 1, 0, 0},
		{"incident insert", "name: InsertRecoveryItem :", false, 1, 0, 0},
		{"audit insert", "INSERT INTO audit_logs", false, 1, 1, 0},
		{"late completion failure", "name: NotifyRunEvents", true, 0, 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, pool, eng, org := newHarness(t)
			claim := recoveryHookClaim(t, ctx, pool, eng, org)
			var hits int
			eng.wrapTx = func(db store.DBTX) store.DBTX {
				return &recoveryHookFault{DBTX: db, match: tc.match, hits: &hits}
			}
			err := eng.FailNode(ctx, claim, errors.New("synthetic failure"))
			if (err != nil) != tc.wantError {
				t.Fatalf("completion error=%v, wantError=%v", err, tc.wantError)
			}
			if hits == 0 {
				t.Fatal("SQL failure was not exercised")
			}
			assertRecoveryHookCounts(t, ctx, pool, org, tc.failures, tc.items, tc.receipts)
			var status string
			if err := pool.QueryRow(ctx, `SELECT status FROM run_nodes WHERE id = $1`, claim.RowID).Scan(&status); err != nil {
				t.Fatal(err)
			}
			wantStatus := "failed"
			if tc.wantError {
				wantStatus = "running"
			}
			if status != wantStatus {
				t.Fatalf("node status=%s, want %s", status, wantStatus)
			}
		})
	}
}

func TestRecoveryItemHookDebounceAtomicity(t *testing.T) {
	for _, failBump := range []bool{false, true} {
		t.Run(fmt.Sprintf("failBump=%v", failBump), func(t *testing.T) {
			ctx, pool, eng, org := newHarness(t)
			first := recoveryHookClaim(t, ctx, pool, eng, org)
			second := recoveryHookClaim(t, ctx, pool, eng, org)
			if err := eng.FailNode(ctx, first, errors.New("same failure")); err != nil {
				t.Fatal(err)
			}
			var hits int
			if failBump {
				eng.wrapTx = func(db store.DBTX) store.DBTX {
					return &recoveryHookFault{DBTX: db, match: "name: BumpRecoveryItemOccurrence", hits: &hits}
				}
			}
			if err := eng.FailNode(ctx, second, errors.New("same failure")); err != nil {
				t.Fatal(err)
			}
			wantChildren, wantOccurrences, wantReceipts := 1, 2, 2
			if failBump {
				wantChildren, wantOccurrences, wantReceipts = 0, 1, 1
				if hits != 1 {
					t.Fatal("occurrence failure not exercised")
				}
			}
			assertRecoveryHookCounts(t, ctx, pool, org, 2, 1, wantReceipts)
			var children, occurrences int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM recovery_item_children WHERE org_id = $1`, org).Scan(&children); err != nil {
				t.Fatal(err)
			}
			if err := pool.QueryRow(ctx, `SELECT occurrence_count FROM recovery_items WHERE org_id = $1`, org).Scan(&occurrences); err != nil {
				t.Fatal(err)
			}
			if children != wantChildren || occurrences != wantOccurrences {
				t.Fatalf("children=%d occurrences=%d, want %d/%d", children, occurrences, wantChildren, wantOccurrences)
			}
			// A successful receipt describes the same system actor as the old writer.
			var actor string
			var userID *string
			if err := pool.QueryRow(ctx, `SELECT metadata->>'actor', user_id FROM audit_logs WHERE org_id = $1 AND action = 'recovery.item.created'`, org).Scan(&actor, &userID); err != nil {
				t.Fatal(err)
			}
			if actor != "system" || userID != nil {
				t.Fatalf("system receipt actor=%q user=%v", actor, userID)
			}
		})
	}
}

func TestRecoveryItemHookHonorsTenantDisable(t *testing.T) {
	ctx, pool, eng, org := newHarness(t)
	claim := recoveryHookClaim(t, ctx, pool, eng, org)
	if _, err := pool.Exec(ctx, `INSERT INTO org_configs (id, org_id, key, value_json, category, description, value_type)
  VALUES ($1, $2, 'recovery.autoCreateItems', 'false', 'recovery', 'test', 'boolean')`, org+"-disabled", org); err != nil {
		t.Fatal(err)
	}
	if err := eng.FailNode(ctx, claim, errors.New("synthetic failure")); err != nil {
		t.Fatal(err)
	}
	assertRecoveryHookCounts(t, ctx, pool, org, 1, 0, 0)
}
