package httpapi

import (
	"context"
	"math"
	"time"

	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/store"
)

// The fit runs daily. After two missed opportunities, an older curve must
// not keep claiming to represent the rolling feedback window.
const calibrationMaxAge = 48 * time.Hour

func activeCalibrationCurve(row store.ConfidenceCalibration, now time.Time) *recovery.CalibrationCurve {
	slope, intercept := float64(row.CurveSlope), float64(row.CurveIntercept)
	acceptRate := float64(row.AcceptRate)
	if !isFeedbackApproachLabel(row.ApproachLabel) ||
		row.SampleSize < recovery.MinCalibrationSamples ||
		math.IsNaN(acceptRate) || math.IsInf(acceptRate, 0) || acceptRate < 0 || acceptRate > 1 ||
		slope <= 0 ||
		math.IsNaN(slope) || math.IsInf(slope, 0) ||
		math.IsNaN(intercept) || math.IsInf(intercept, 0) ||
		row.LastComputedAt.IsZero() || row.LastComputedAt.Before(now.Add(-calibrationMaxAge)) ||
		row.LastComputedAt.After(now.Add(5*time.Minute)) {
		return nil
	}
	return &recovery.CalibrationCurve{Slope: slope, Intercept: intercept}
}

// A calibration read is advisory to a valid provider suggestion. Tenant config
// and rows are read through the request's organization; missing or invalid
// evidence leaves the raw confidence intact and never fails the AI response.
func (s *V1Server) patchCalibrationCurves(ctx context.Context, orgID string) map[string]*recovery.CalibrationCurve {
	if !orgconfig.LoadBool(ctx, s.pool, orgID, "ai.confidenceCalibrationEnabled") {
		return nil
	}
	rows, err := store.New(s.pool).ListConfidenceCalibrations(ctx, orgID)
	if err != nil {
		return nil
	}
	now := time.Now().UTC()
	curves := make(map[string]*recovery.CalibrationCurve, len(rows))
	for _, row := range rows {
		if curve := activeCalibrationCurve(row, now); curve != nil {
			curves[row.ApproachLabel] = curve
		}
	}
	return curves
}

func calibratedPatchConfidence(raw float64, curve *recovery.CalibrationCurve) float64 {
	if curve == nil {
		return raw
	}
	return float64(recovery.ApplyCalibration(raw, curve))
}
