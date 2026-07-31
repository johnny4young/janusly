// Recovery value metrics — the north-star projection over real redrives.
// GET /recovery/metrics (both wires): median + p90 time from failure
// detection (the dead-letter row) to the run's verified terminal success
// after a replay, plus the legacy arithmetic-average MTTR for
// compatibility with the reference's older dashboard shape.
package httpapi

import (
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
	stats, err := store.New(s.pool).QueryVerifiedRecoveryStats(r.Context(), store.QueryVerifiedRecoveryStatsParams{
		OrgID: rc.orgID, WindowDays: int32(windowDays),
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
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
	costRows, err := store.New(s.pool).QueryCostByProvider(r.Context(), store.QueryCostByProviderParams{
		TargetOrg: rc.orgID, Since: since,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
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
	return opOK(map[string]any{
		"verifiedRecovery": map[string]any{
			"metric":     "verifiedRecovery",
			"unit":       "ms",
			"sampleSize": stats.SampleSize,
			"p50Ms":      numberOrNull(stats.P50Ms),
			"p90Ms":      numberOrNull(stats.P90Ms),
		},
		"mttrMs":         numberOrNull(stats.MttrAvgMs),
		"windowDays":     windowDays,
		"costByProvider": costByProvider,
	})
}
