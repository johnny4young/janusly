// The confidence-calibration sweep: per org that opted in (the
// ai.confidenceCalibrationEnabled toggle, default on) and produced
// labeled feedback in the window, fit one curve per approach from the
// rolling 30-day accept/reject history and upsert the stored row.
// Deterministic, bounded (5000 samples per approach, 500 orgs per pass),
// and abstinent: an approach below the sample floor or with a
// non-monotonic fit keeps NO new curve (the read side shows raw confidence
// once any older curve expires).
package engine

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/johnny4young/janusly/internal/observability"
	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/store"
)

// CalibrationWindowDays is the rolling fit window.
const CalibrationWindowDays = 30

// RunCalibrationSweep walks one full pass. Per-org failures do not prevent
// other orgs progressing, but the first error makes the pass visibly fail
// instead of advancing liveness on an incomplete sweep.
func (e *Engine) RunCalibrationSweep(ctx context.Context) (int, error) {
	q := store.New(e.pool)
	orgs, err := q.ListOrgsWithFeedback(ctx, CalibrationWindowDays)
	if err != nil {
		return 0, err
	}
	written := 0
	var passErr error
	for _, orgID := range orgs {
		if err := ctx.Err(); err != nil {
			return written, errors.Join(passErr, err)
		}
		if !orgconfig.LoadBool(ctx, e.pool, orgID, "ai.confidenceCalibrationEnabled") {
			continue
		}
		approaches, err := q.ListCalibratableApproaches(ctx, store.ListCalibratableApproachesParams{
			OrgID: orgID, WindowDays: CalibrationWindowDays,
		})
		if err != nil {
			if passErr == nil {
				passErr = err
			}
			continue
		}
		for _, approach := range approaches {
			rows, err := q.ListCalibrationSamples(ctx, store.ListCalibrationSamplesParams{
				OrgID: orgID, ApproachLabel: approach, WindowDays: CalibrationWindowDays,
			})
			if err != nil {
				if passErr == nil {
					passErr = err
				}
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
				if passErr == nil {
					passErr = err
				}
				continue
			}
			written++
		}
	}
	return written, passErr
}

// RunCalibrationLoop makes the first pass after startup, then refreshes daily.
// A failed pass retries after five minutes rather than serving stale curves
// for a whole day. The boot runner owns supervision and drain; this loop owns
// pass telemetry.
func (e *Engine) RunCalibrationLoop(ctx context.Context, every time.Duration, logger *slog.Logger) {
	for ctx.Err() == nil {
		started := time.Now()
		written, err := e.RunCalibrationSweep(ctx)
		if ctx.Err() != nil {
			return
		}
		observability.ObserveSweepPass(observability.SweepCalibration, started, err)
		wait := every
		if err != nil {
			logger.Error("calibration sweep failed", "error", err)
			wait = min(wait, 5*time.Minute)
		} else if written > 0 {
			logger.Info("calibration sweep updated curves", "count", written)
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
