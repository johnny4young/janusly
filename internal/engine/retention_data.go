// Per-org data retention over run_events / audit_logs / usage_events —
// the contract's batched-purge shape: each table sweeps one org at a
// time with that org's catalog window, deleting in bounded batches
// (subquery + LIMIT) so a huge backlog never holds a long transaction,
// honoring per-row hold_until legal holds, and reporting the contract's
// result shape {rowsDeleted, cutoffAt, runtimeMs, cappedByMaxBatches} —
// a capped sweep means more rows remain and the next hourly fire
// continues the drain.
package engine

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"time"

	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/store"
)

// Reference defaults: 10k rows per DELETE, hard 1k-batch runaway stop.
const (
	retentionBatchSizeDefault  = 10_000
	retentionMaxBatchesDefault = 1_000
)

// PurgeResult mirrors the contract's DeleteExpired*Result.
type PurgeResult struct {
	RowsDeleted        int    `json:"rowsDeleted"`
	CutoffAt           string `json:"cutoffAt"`
	RuntimeMs          int64  `json:"runtimeMs"`
	CappedByMaxBatches bool   `json:"cappedByMaxBatches"`
}

// dataRetentionTable binds one table's catalog window to its batch delete.
type dataRetentionTable struct {
	name      string
	configKey string
	deleteFn  func(ctx context.Context, q *store.Queries, org string, cutoff time.Time, batch int32) (int64, error)
}

var dataRetentionTables = []dataRetentionTable{
	{"run_events", "retention.runEventsDays",
		func(ctx context.Context, q *store.Queries, org string, cutoff time.Time, batch int32) (int64, error) {
			return q.DeleteExpiredRunEventsBatch(ctx, store.DeleteExpiredRunEventsBatchParams{
				TargetOrg: org, Cutoff: cutoff, BatchSize: batch,
			})
		}},
	{"audit_logs", "retention.auditLogsDays",
		func(ctx context.Context, q *store.Queries, org string, cutoff time.Time, batch int32) (int64, error) {
			return q.DeleteExpiredAuditLogsBatch(ctx, store.DeleteExpiredAuditLogsBatchParams{
				TargetOrg: org, Cutoff: cutoff, BatchSize: batch,
			})
		}},
	{"usage_events", "retention.usageEventsDays",
		func(ctx context.Context, q *store.Queries, org string, cutoff time.Time, batch int32) (int64, error) {
			return q.DeleteExpiredUsageEventsBatch(ctx, store.DeleteExpiredUsageEventsBatchParams{
				TargetOrg: org, Cutoff: cutoff, BatchSize: batch,
			})
		}},
	// Settled dead letters only; the open queue is operator-owned and never
	// ages out.
	{"dead_letters", "retention.deadLettersDays",
		func(ctx context.Context, q *store.Queries, org string, cutoff time.Time, batch int32) (int64, error) {
			return q.DeleteExpiredDeadLettersBatch(ctx, store.DeleteExpiredDeadLettersBatchParams{
				TargetOrg: org, Cutoff: cutoff, BatchSize: batch,
			})
		}},
}

// ProcessDataRetentionSweep purges expired rows across every org and
// table. batchSize/maxBatches <= 0 use the contract defaults; results
// come back keyed "<org>/<table>" for the caller's logging.
func (e *Engine) ProcessDataRetentionSweep(ctx context.Context, batchSize, maxBatches int) (map[string]PurgeResult, error) {
	if batchSize <= 0 {
		batchSize = retentionBatchSizeDefault
	}
	if maxBatches <= 0 {
		maxBatches = retentionMaxBatchesDefault
	}
	q := store.New(e.pool)
	orgs, err := q.ListOrgsWithRetainableData(ctx)
	if err != nil {
		return nil, err
	}
	configRows, err := q.ListRetentionConfigRows(ctx)
	if err != nil {
		return nil, err
	}
	tenantRows := map[string]map[string]json.RawMessage{}
	for _, row := range configRows {
		if tenantRows[row.OrgID] == nil {
			tenantRows[row.OrgID] = map[string]json.RawMessage{}
		}
		tenantRows[row.OrgID][row.Key] = row.ValueJson
	}
	results := map[string]PurgeResult{}
	for _, orgID := range orgs {
		for _, table := range dataRetentionTables {
			resolved, _ := orgconfig.ResolveValue(table.configKey, tenantRows[orgID], os.LookupEnv)
			windowDays := 0
			if v, ok := resolved.(float64); ok {
				windowDays = int(v)
			}
			if windowDays < 1 {
				continue // resolution degraded; skip rather than purge with a wrong window
			}
			cutoff := e.now().UTC().AddDate(0, 0, -windowDays)
			startedAt := time.Now()
			result := PurgeResult{CutoffAt: cutoff.Format(time.RFC3339)}
			// Archival replaces the plain delete for run events when the
			// tenant opted in: export first, delete exactly what was
			// exported, and stop the table's drain if the store refuses.
			archive := false
			if table.name == "run_events" {
				archived, _ := orgconfig.ResolveValue("retention.archiveRunEvents", tenantRows[orgID], os.LookupEnv)
				archive, _ = archived.(bool)
			}
			for batch := 0; batch < maxBatches; batch++ {
				var deleted int64
				var err error
				if archive {
					var archivedRows int
					archivedRows, err = e.archiveExpiredRunEvents(ctx, q, orgID, cutoff, int32(batchSize))
					deleted = int64(archivedRows)
				} else {
					deleted, err = table.deleteFn(ctx, q, orgID, cutoff, int32(batchSize))
				}
				if err != nil {
					return results, err
				}
				result.RowsDeleted += int(deleted)
				if int(deleted) < batchSize {
					break
				}
				if batch == maxBatches-1 {
					result.CappedByMaxBatches = true
				}
			}
			result.RuntimeMs = time.Since(startedAt).Milliseconds()
			if result.RowsDeleted > 0 {
				results[orgID+"/"+table.name] = result
			}
		}
	}
	return results, nil
}

// runDataRetention is the hourly runner's tail step: log each non-empty
// per-org/table result so an operator can follow the drain.
func (e *Engine) runDataRetention(ctx context.Context, logger *slog.Logger) {
	results, err := e.ProcessDataRetentionSweep(ctx, 0, 0)
	if err != nil {
		if ctx.Err() == nil {
			logger.Error("data retention sweep failed", "error", err)
		}
		return
	}
	for scope, result := range results {
		logger.Info("retention purged expired rows", "scope", scope,
			"rows", result.RowsDeleted, "cutoff", result.CutoffAt,
			"runtimeMs", result.RuntimeMs, "capped", result.CappedByMaxBatches)
	}
}
