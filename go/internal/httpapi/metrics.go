// Recovery value metrics — the north-star projection over real redrives.
// GET /recovery/metrics (both wires): median + p90 time from failure
// detection (the dead-letter row) to the run's verified terminal success
// after a replay, plus the legacy arithmetic-average MTTR for
// compatibility with the reference's older dashboard shape.
package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/johnny4young/janusly/go/internal/store"
)

func (s *V1Server) recoveryMetricsCore(r *http.Request, rc v1Request) opResult {
	windowDays := 30
	if raw := r.URL.Query().Get("windowDays"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			windowDays = min(90, max(1, parsed))
		}
	}
	value, err := s.recoveryMetricsValue(r.Context(), rc.orgID, windowDays)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	return opOK(value)
}

// recoveryMetricsValue is the shared read-model body (the focused route
// and the coalesced Home snapshot must not drift).
func (s *V1Server) recoveryMetricsValue(ctx context.Context, orgID string, windowDays int) (map[string]any, error) {
	stats, err := store.New(s.pool).QueryVerifiedRecoveryStats(ctx, store.QueryVerifiedRecoveryStatsParams{
		OrgID: orgID, WindowDays: int32(windowDays),
	})
	if err != nil {
		return nil, err
	}
	// The query encodes "no sample" as -1 so sqlc scans a plain float.
	numberOrNull := func(value float64) any {
		if stats.SampleSize == 0 || value < 0 {
			return nil
		}
		return value
	}
	// Operations LLM cost rollup: exact totals over the whole window,
	// bounded to 100 provider/model groups plus one explicit remainder.
	since := time.Now().UTC().AddDate(0, 0, -windowDays)
	costRows, err := store.New(s.pool).QueryCostByProvider(ctx, store.QueryCostByProviderParams{
		TargetOrg: orgID, Since: since,
	})
	if err != nil {
		return nil, err
	}
	costByProvider := make([]map[string]any, 0, len(costRows))
	for _, row := range costRows {
		costByProvider = append(costByProvider, map[string]any{
			"provider": row.Provider, "model": row.Model,
			"usd": row.Usd, "tokens": row.Tokens,
			"inputTokens": row.InputTokens, "cachedInputTokens": row.CachedInputTokens,
			"cacheCreationInputTokens": row.CacheCreationInputTokens,
			"calls":                    row.Calls, "aggregated": row.Aggregated,
		})
	}
	// Set-once first-action latency: recovery-item transitions stamp
	// first_action_at once; item-less tenants contribute through the
	// pre-enqueue replay claim (never both for one incident).
	firstAction, err := store.New(s.pool).QueryTimeToFirstAction(ctx, store.QueryTimeToFirstActionParams{
		OrgID: orgID, CreatedAt: since,
	})
	if err != nil {
		return nil, err
	}
	floatOrNull := func(value float64, samples int32) any {
		if samples == 0 || value < 0 {
			return nil
		}
		return value
	}
	// Seven-day recurrence bound to the IMMUTABLE impact event: the fix
	// boundary is terminal success, and a same-signature later incident
	// inside the window marks it recurred (sandbox replays never count).
	recurrence, err := store.New(s.pool).QueryRecoveryRecurrence(ctx, store.QueryRecoveryRecurrenceParams{
		OrgID: orgID, RecoveredAt: since,
	})
	if err != nil {
		return nil, err
	}
	var recurrenceRate any
	if recurrence.Resolved > 0 {
		recurrenceRate = float64(recurrence.Resolved-recurrence.Recurred) / float64(recurrence.Resolved) * 100
	}
	return map[string]any{
		"verifiedRecovery": map[string]any{
			"metric":     "verifiedRecovery",
			"unit":       "ms",
			"sampleSize": stats.SampleSize,
			"p50Ms":      numberOrNull(stats.P50Ms),
			"p90Ms":      numberOrNull(stats.P90Ms),
		},
		"mttrMs": numberOrNull(stats.MttrAvgMs),
		"timeToFirstAction": map[string]any{
			"unit":       "seconds",
			"sampleSize": firstAction.SampleSize,
			"avgSeconds": floatOrNull(firstAction.AvgSeconds, firstAction.SampleSize),
			"p95Seconds": floatOrNull(firstAction.P95Seconds, firstAction.SampleSize),
		},
		"recurrence": map[string]any{
			"resolved": recurrence.Resolved, "recurred": recurrence.Recurred,
			"stayedFixedRate": recurrenceRate, "windowDays": 7,
		},
		"windowDays":     windowDays,
		"costByProvider": costByProvider,
	}, nil
}
