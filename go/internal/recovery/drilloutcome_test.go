package recovery

import (
	"testing"
	"time"
)

func timePtr(value time.Time) *time.Time { return &value }

// The outcome precedence ported from the reference: capped wins over
// everything (measurement_incomplete), recovered over accepted, an open
// latest is awaiting_action, a claimed unresolved replay is in progress —
// and the 7-day recurrence window flows monitoring → clear / recurred.
func TestBuildRecoveryDrillOutcome(t *testing.T) {
	base := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	now := base.Add(time.Hour)

	// Recovered with terminal impact evidence + monitoring window.
	recovered := BuildRecoveryDrillOutcome(DrillOutcomeFacts{
		RootCreatedAt: timePtr(base), RootStatus: "replayed",
		LatestDeadLetterID: "dl-1", LatestStatus: "replayed", AttemptCount: 2,
		ReplayStartedAt: timePtr(base.Add(time.Minute)),
		RecoveredAt:     timePtr(base.Add(10 * time.Minute)),
	}, now)
	if recovered.Status != "recovered" || *recovered.Evidence != "terminal_impact" ||
		*recovered.ElapsedMs != int64(10*60*1000) || recovered.Recurrence.Status != "monitoring" {
		t.Fatalf("recovered: %+v", recovered)
	}

	// Past the window with no recurrence → clear; a recurrence → recurred.
	clear := BuildRecoveryDrillOutcome(DrillOutcomeFacts{
		RootCreatedAt: timePtr(base), LatestDeadLetterID: "dl-1", LatestStatus: "replayed",
		AttemptCount: 1, RecoveredAt: timePtr(base),
	}, base.Add(8*24*time.Hour))
	if clear.Recurrence.Status != "clear" {
		t.Fatalf("clear: %+v", clear.Recurrence)
	}
	recurred := BuildRecoveryDrillOutcome(DrillOutcomeFacts{
		RootCreatedAt: timePtr(base), LatestDeadLetterID: "dl-1", LatestStatus: "replayed",
		AttemptCount: 1, RecoveredAt: timePtr(base), RecurredAt: timePtr(base.Add(2 * 24 * time.Hour)),
	}, now)
	if recurred.Recurrence.Status != "recurred" || recurred.Recurrence.RecurredAt == nil {
		t.Fatalf("recurred: %+v", recurred.Recurrence)
	}

	// Accepted loss (explicit resolution) only when NOT recovered.
	accepted := BuildRecoveryDrillOutcome(DrillOutcomeFacts{
		RootCreatedAt: timePtr(base), LatestDeadLetterID: "dl-1", LatestStatus: "resolved",
		AttemptCount: 1, AcceptedItemAt: timePtr(base.Add(5 * time.Minute)),
	}, now)
	if accepted.Status != "accepted_loss" || *accepted.Evidence != "explicit_resolution" {
		t.Fatalf("accepted: %+v", accepted)
	}

	// Recovered DOMINATES accepted.
	both := BuildRecoveryDrillOutcome(DrillOutcomeFacts{
		RootCreatedAt: timePtr(base), LatestDeadLetterID: "dl-1", LatestStatus: "resolved",
		AttemptCount: 1, RecoveredAt: timePtr(base.Add(time.Minute)),
		AcceptedItemAt: timePtr(base.Add(2 * time.Minute)),
	}, now)
	if both.Status != "recovered" {
		t.Fatalf("recovered must dominate: %+v", both)
	}

	// A capped chain refuses to invent an outcome.
	capped := BuildRecoveryDrillOutcome(DrillOutcomeFacts{
		RootCreatedAt: timePtr(base), LatestDeadLetterID: "dl-1", LatestStatus: "replayed",
		AttemptCount: 100, ChainCapped: true, RecoveredAt: timePtr(base.Add(time.Minute)),
	}, now)
	if capped.Status != "measurement_incomplete" || capped.Evidence != nil ||
		capped.CompletedAt != nil || capped.Recurrence.Status != "not_applicable" {
		t.Fatalf("capped: %+v", capped)
	}

	// Open latest → awaiting; claimed-but-open resolution → in progress.
	awaiting := BuildRecoveryDrillOutcome(DrillOutcomeFacts{
		RootCreatedAt: timePtr(base), LatestDeadLetterID: "dl-1", LatestStatus: "open", AttemptCount: 1,
	}, now)
	if awaiting.Status != "awaiting_action" {
		t.Fatalf("awaiting: %+v", awaiting)
	}
	inProgress := BuildRecoveryDrillOutcome(DrillOutcomeFacts{
		RootCreatedAt: timePtr(base), LatestDeadLetterID: "dl-1", LatestStatus: "replayed",
		AttemptCount: 1, ReplayStartedAt: timePtr(base.Add(time.Minute)),
	}, now)
	if inProgress.Status != "replay_in_progress" {
		t.Fatalf("in progress: %+v", inProgress)
	}
}
