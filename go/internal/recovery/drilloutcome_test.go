package recovery

import (
	"testing"
	"time"
)

// The outcome precedence ported from the reference: capped wins over
// everything (measurement_incomplete), recovered over accepted, an open
// latest is awaiting_action, a claimed unresolved replay is in progress —
// and the 7-day recurrence window flows monitoring → clear / recurred.
func TestBuildRecoveryDrillOutcome(t *testing.T) {
	base := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	now := base.Add(time.Hour)

	// Recovered with terminal impact evidence + monitoring window.
	recovered := BuildRecoveryDrillOutcome(DrillOutcomeFacts{
		RootCreatedAt: new(base), RootStatus: "replayed",
		LatestDeadLetterID: "dl-1", LatestStatus: "replayed", AttemptCount: 2,
		ReplayStartedAt: new(base.Add(time.Minute)),
		RecoveredAt:     new(base.Add(10 * time.Minute)),
	}, now)
	if recovered.Status != "recovered" || *recovered.Evidence != "terminal_impact" ||
		*recovered.ElapsedMs != int64(10*60*1000) || recovered.Recurrence.Status != "monitoring" {
		t.Fatalf("recovered: %+v", recovered)
	}

	// Past the window with no recurrence → clear; a recurrence → recurred.
	clear := BuildRecoveryDrillOutcome(DrillOutcomeFacts{
		RootCreatedAt: new(base), LatestDeadLetterID: "dl-1", LatestStatus: "replayed",
		AttemptCount: 1, RecoveredAt: new(base),
	}, base.Add(8*24*time.Hour))
	if clear.Recurrence.Status != "clear" {
		t.Fatalf("clear: %+v", clear.Recurrence)
	}
	recurred := BuildRecoveryDrillOutcome(DrillOutcomeFacts{
		RootCreatedAt: new(base), LatestDeadLetterID: "dl-1", LatestStatus: "replayed",
		AttemptCount: 1, RecoveredAt: new(base), RecurredAt: new(base.Add(2 * 24 * time.Hour)),
	}, now)
	if recurred.Recurrence.Status != "recurred" || recurred.Recurrence.RecurredAt == nil {
		t.Fatalf("recurred: %+v", recurred.Recurrence)
	}

	// Accepted loss (explicit resolution) only when NOT recovered.
	accepted := BuildRecoveryDrillOutcome(DrillOutcomeFacts{
		RootCreatedAt: new(base), LatestDeadLetterID: "dl-1", LatestStatus: "resolved",
		AttemptCount: 1, AcceptedItemAt: new(base.Add(5 * time.Minute)),
	}, now)
	if accepted.Status != "accepted_loss" || *accepted.Evidence != "explicit_resolution" {
		t.Fatalf("accepted: %+v", accepted)
	}

	// Recovered DOMINATES accepted.
	both := BuildRecoveryDrillOutcome(DrillOutcomeFacts{
		RootCreatedAt: new(base), LatestDeadLetterID: "dl-1", LatestStatus: "resolved",
		AttemptCount: 1, RecoveredAt: new(base.Add(time.Minute)),
		AcceptedItemAt: new(base.Add(2 * time.Minute)),
	}, now)
	if both.Status != "recovered" {
		t.Fatalf("recovered must dominate: %+v", both)
	}

	// A capped chain refuses to invent an outcome.
	capped := BuildRecoveryDrillOutcome(DrillOutcomeFacts{
		RootCreatedAt: new(base), LatestDeadLetterID: "dl-1", LatestStatus: "replayed",
		AttemptCount: 100, ChainCapped: true, RecoveredAt: new(base.Add(time.Minute)),
	}, now)
	if capped.Status != "measurement_incomplete" || capped.Evidence != nil ||
		capped.CompletedAt != nil || capped.Recurrence.Status != "not_applicable" {
		t.Fatalf("capped: %+v", capped)
	}

	// Open latest → awaiting; claimed-but-open resolution → in progress.
	awaiting := BuildRecoveryDrillOutcome(DrillOutcomeFacts{
		RootCreatedAt: new(base), LatestDeadLetterID: "dl-1", LatestStatus: "open", AttemptCount: 1,
	}, now)
	if awaiting.Status != "awaiting_action" {
		t.Fatalf("awaiting: %+v", awaiting)
	}
	inProgress := BuildRecoveryDrillOutcome(DrillOutcomeFacts{
		RootCreatedAt: new(base), LatestDeadLetterID: "dl-1", LatestStatus: "replayed",
		AttemptCount: 1, ReplayStartedAt: new(base.Add(time.Minute)),
	}, now)
	if inProgress.Status != "replay_in_progress" {
		t.Fatalf("in progress: %+v", inProgress)
	}
}

// The calibration fit: monotonic-only curves, sample floor abstention,
// and the clamped monotonic application.
func TestFitAndApplyCalibration(t *testing.T) {
	// Below the floor → nil.
	if FitCalibrationCurve(make([]CalibrationSample, MinCalibrationSamples-1)) != nil {
		t.Fatal("below the floor must abstain")
	}
	// A clean positive relationship fits: low confidence mostly rejected,
	// high mostly accepted.
	var samples []CalibrationSample
	for i := range 15 {
		samples = append(samples, CalibrationSample{RawConfidence: 20, Accepted: i < 3})
	}
	for i := range 15 {
		samples = append(samples, CalibrationSample{RawConfidence: 85, Accepted: i < 12})
	}
	curve := FitCalibrationCurve(samples)
	if curve == nil || curve.Slope <= 0 || curve.SampleSize != 30 {
		t.Fatalf("positive fit expected: %+v", curve)
	}
	// Monotonic + clamped application; identity without a curve.
	low, high := ApplyCalibration(20, curve), ApplyCalibration(85, curve)
	if low > high || low < 0 || high > 100 {
		t.Fatalf("monotonic clamp: %d/%d", low, high)
	}
	if ApplyCalibration(63.4, nil) != 63 {
		t.Fatal("nil curve must be identity (rounded)")
	}
	// An INVERTED relationship refuses the curve (negative slope).
	var inverted []CalibrationSample
	for i := range 15 {
		inverted = append(inverted, CalibrationSample{RawConfidence: 20, Accepted: i < 13})
	}
	for i := range 15 {
		inverted = append(inverted, CalibrationSample{RawConfidence: 85, Accepted: i < 2})
	}
	if FitCalibrationCurve(inverted) != nil {
		t.Fatal("non-monotonic fit must refuse")
	}
	// One bucket only → degenerate geometry → nil.
	var flat []CalibrationSample
	for i := range 30 {
		flat = append(flat, CalibrationSample{RawConfidence: 50, Accepted: i%2 == 0})
	}
	if FitCalibrationCurve(flat) != nil {
		t.Fatal("single-bucket fit must refuse")
	}
}
