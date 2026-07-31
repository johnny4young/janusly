// The confidence-calibration sweep: per org that opted in (the
// ai.confidenceCalibrationEnabled toggle, default on) and produced
// labeled feedback in the window, fit one curve per approach from the
// rolling 30-day accept/reject history and upsert the stored row.
// Deterministic, bounded (5000 samples per approach, 500 orgs per pass),
// and abstinent: an approach below the sample floor or with a
// non-monotonic fit keeps NO curve (the read side shows raw confidence).
package engine

import (
	"context"
	"log/slog"

	"github.com/johnny4young/janusly/go/internal/orgconfig"
	"github.com/johnny4young/janusly/go/internal/recovery"
	"github.com/johnny4young/janusly/go/internal/store"
)

// CalibrationWindowDays is the rolling fit window.
const CalibrationWindowDays = 30

// RunCalibrationSweep walks one full pass. Returns curves written.
func (e *Engine) RunCalibrationSweep(ctx context.Context) int {
	q := store.New(e.pool)
	orgs, err := q.ListOrgsWithFeedback(ctx, CalibrationWindowDays)
	if err != nil {
		slog.Warn("[calibration] org scan failed", "error", err)
		return 0
	}
	written := 0
	for _, orgID := range orgs {
		if !orgconfig.LoadBool(ctx, e.pool, orgID, "ai.confidenceCalibrationEnabled") {
			continue
		}
		approaches, err := q.ListCalibratableApproaches(ctx, store.ListCalibratableApproachesParams{
			OrgID: orgID, WindowDays: CalibrationWindowDays,
		})
		if err != nil {
			continue
		}
		for _, approach := range approaches {
			rows, err := q.ListCalibrationSamples(ctx, store.ListCalibrationSamplesParams{
				OrgID: orgID, ApproachLabel: approach, WindowDays: CalibrationWindowDays,
			})
			if err != nil {
				continue
			}
			samples := make([]recovery.CalibrationSample, 0, len(rows))
			for _, row := range rows {
				if !row.RawConfidence.Valid {
					continue
				}
				samples = append(samples, recovery.CalibrationSample{
					RawConfidence: float64(row.RawConfidence.Int32), Accepted: row.Accepted,
				})
			}
			curve := recovery.FitCalibrationCurve(samples)
			if curve == nil {
				continue // abstain — never persist a curve that could mislead
			}
			if err := q.UpsertConfidenceCalibration(ctx, store.UpsertConfidenceCalibrationParams{
				ID: e.newID(), OrgID: orgID, ApproachLabel: approach,
				AcceptRate: float32(curve.AcceptRate), SampleSize: int32(curve.SampleSize),
				CurveSlope: float32(curve.Slope), CurveIntercept: float32(curve.Intercept),
			}); err != nil {
				slog.Warn("[calibration] upsert failed", "orgId", orgID, "approach", approach, "error", err)
				continue
			}
			written++
		}
	}
	return written
}
