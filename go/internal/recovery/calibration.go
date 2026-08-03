// Confidence calibration — the PURE curve machinery ported from the
// reference's confidence-calibration.ts: a per-(org, approach) linear
// curve maps an LLM's self-rated suggestion confidence onto the
// empirically observed accept rate. The fit is weighted least-squares
// over 10-point buckets; a non-positive slope is REFUSED (applying it
// could invert the ordering of two suggestions), and applying a curve is
// therefore always monotonic and clamped into [0, 100].
package recovery

import "math"

// MinCalibrationSamples: below this many labeled decisions the fit
// abstains (a handful of clicks must not steer the number).
const MinCalibrationSamples = 20

// CalibrationBucketWidth groups raw confidences into 10-point buckets.
const CalibrationBucketWidth = 10

// CalibrationSubtitleDelta: below this many points of correction the UI
// suppresses the "(model self-rated X%)" subtitle.
const CalibrationSubtitleDelta = 10

// CalibrationSample is one labeled accept/reject decision.
type CalibrationSample struct {
	RawConfidence float64
	Accepted      bool
}

// CalibrationCurve is the persisted per-approach linear map.
type CalibrationCurve struct {
	Slope      float64
	Intercept  float64
	SampleSize int
	AcceptRate float64
}

func clampFloat(value, low, high float64) float64 {
	return min(high, max(low, value))
}

func bucketIndex(rawConfidence float64) int {
	clamped := clampFloat(rawConfidence, 0, 100)
	idx := int(math.Floor(clamped / CalibrationBucketWidth))
	last := 100/CalibrationBucketWidth - 1
	if idx > last {
		idx = last
	}
	return idx
}

func bucketMidpoint(idx int) float64 {
	return float64(idx)*CalibrationBucketWidth + CalibrationBucketWidth/2.0
}

// FitCalibrationCurve fits the weighted least-squares line over the
// bucketed samples; nil means "no curve" (below threshold, degenerate
// geometry, or a non-monotonic fit) and the read side keeps raw values.
func FitCalibrationCurve(samples []CalibrationSample) *CalibrationCurve {
	if len(samples) < MinCalibrationSamples {
		return nil
	}
	accepted := 0
	for _, sample := range samples {
		if sample.Accepted {
			accepted++
		}
	}
	acceptRate := float64(accepted) / float64(len(samples))

	type bucket struct{ count, accepted int }
	buckets := map[int]*bucket{}
	for _, sample := range samples {
		idx := bucketIndex(sample.RawConfidence)
		entry := buckets[idx]
		if entry == nil {
			entry = &bucket{}
			buckets[idx] = entry
		}
		entry.count++
		if sample.Accepted {
			entry.accepted++
		}
	}
	if len(buckets) < 2 {
		return nil
	}

	var sumW, sumWX, sumWY, sumWXX, sumWXY float64
	for idx, entry := range buckets {
		x := bucketMidpoint(idx)
		y := float64(entry.accepted) / float64(entry.count) * 100
		w := float64(entry.count)
		sumW += w
		sumWX += w * x
		sumWY += w * y
		sumWXX += w * x * x
		sumWXY += w * x * y
	}
	denom := sumW*sumWXX - sumWX*sumWX
	if denom == 0 {
		return nil
	}
	slope := (sumW*sumWXY - sumWX*sumWY) / denom
	intercept := (sumWY - slope*sumWX) / sumW
	if !(slope > 0) || math.IsInf(slope, 0) || math.IsNaN(slope) ||
		math.IsInf(intercept, 0) || math.IsNaN(intercept) {
		return nil
	}
	return &CalibrationCurve{
		Slope: slope, Intercept: intercept,
		SampleSize: len(samples), AcceptRate: acceptRate,
	}
}

// ApplyCalibration maps one raw confidence through the curve (identity
// when nil), rounded and clamped into [0, 100] — monotonic by the
// positive-slope guarantee.
func ApplyCalibration(rawConfidence float64, curve *CalibrationCurve) int {
	if curve == nil {
		return int(clampFloat(math.Round(rawConfidence), 0, 100))
	}
	calibrated := curve.Slope*rawConfidence + curve.Intercept
	return int(clampFloat(math.Round(calibrated), 0, 100))
}
