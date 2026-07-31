// Recovery value metrics — the north-star projection over real redrives.
// GET /recovery/metrics (both wires): median + p90 time from failure
// detection (the dead-letter row) to the run's verified terminal success
// after a replay, plus the legacy arithmetic-average MTTR for
// compatibility with the reference's older dashboard shape.
package httpapi

import (
	"net/http"
	"strconv"

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
	return opOK(map[string]any{
		"verifiedRecovery": map[string]any{
			"metric":     "verifiedRecovery",
			"unit":       "ms",
			"sampleSize": stats.SampleSize,
			"p50Ms":      numberOrNull(stats.P50Ms),
			"p90Ms":      numberOrNull(stats.P90Ms),
		},
		"mttrMs":     numberOrNull(stats.MttrAvgMs),
		"windowDays": windowDays,
	})
}
