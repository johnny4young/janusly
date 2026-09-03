// Eval-dataset retention turns each dataset's optional retention_days into an
// enforced lifecycle. The sweep is global because the expiry is stored on the
// dataset itself, but every delete matches both org and dataset id. Bounded
// batches plus SKIP LOCKED in the store query keep concurrent replicas safe and
// prevent one large evaluation backlog from monopolizing maintenance.
package engine

import (
	"context"
	"log/slog"
	"time"

	"github.com/johnny4young/janusly/internal/store"
)

const (
	evalRetentionBatchSizeDefault  = 100
	evalRetentionMaxBatchesDefault = 100
)

// EvalDatasetPurgeResult reports one bounded pass. Experiments intentionally
// survive dataset expiry as immutable aggregate evidence; their stored summary
// contains no input examples.
type EvalDatasetPurgeResult struct {
	DatasetsDeleted    int
	RuntimeMs          int64
	CappedByMaxBatches bool
}

// ProcessEvalDatasetRetentionSweep drains datasets whose own retention window
// has elapsed. Non-positive arguments select bounded production defaults.
func (e *Engine) ProcessEvalDatasetRetentionSweep(ctx context.Context, batchSize, maxBatches int) (EvalDatasetPurgeResult, error) {
	if batchSize <= 0 {
		batchSize = evalRetentionBatchSizeDefault
	}
	if maxBatches <= 0 {
		maxBatches = evalRetentionMaxBatchesDefault
	}
	// sqlc's LIMIT parameter is int32. Internal callers should not be able to
	// wrap an oversized int into a negative/unbounded query argument.
	if batchSize > int(^uint32(0)>>1) {
		batchSize = int(^uint32(0) >> 1)
	}

	startedAt := time.Now()
	result := EvalDatasetPurgeResult{}
	q := store.New(e.pool)
	for batch := 0; batch < maxBatches; batch++ {
		deleted, err := q.PurgeExpiredEvalDatasetsBatch(ctx, store.PurgeExpiredEvalDatasetsBatchParams{
			NowAt: e.now().UTC(), BatchSize: int32(batchSize),
		})
		if err != nil {
			result.RuntimeMs = time.Since(startedAt).Milliseconds()
			return result, err
		}
		result.DatasetsDeleted += int(deleted)
		if int(deleted) < batchSize {
			break
		}
		if batch == maxBatches-1 {
			result.CappedByMaxBatches = true
		}
	}
	result.RuntimeMs = time.Since(startedAt).Milliseconds()
	return result, nil
}

func (e *Engine) runEvalDatasetRetention(ctx context.Context, logger *slog.Logger) error {
	result, err := e.ProcessEvalDatasetRetentionSweep(ctx, 0, 0)
	if err != nil {
		if ctx.Err() == nil {
			logger.Error("eval dataset retention sweep failed", "error", err)
		}
		return err
	}
	if result.DatasetsDeleted > 0 {
		logger.Info("retention purged expired eval datasets",
			"datasets", result.DatasetsDeleted,
			"runtimeMs", result.RuntimeMs,
			"capped", result.CappedByMaxBatches)
	}
	return nil
}
