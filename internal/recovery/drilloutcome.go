// Measured Recovery Drill outcomes — the PURE composition implements
// the contract's buildRecoveryDrillOutcome: truthful status, duration,
// and recurrence derived from durable facts only (the DLQ chain, the
// terminal impact fact, explicit resolutions, and the 7-day recurrence
// window). No wall-clock guesswork: a capped chain reports
// measurement_incomplete rather than inventing an outcome.
package recovery

import "time"

// RecoveryDrillReplayChainLimit bounds one drill's measured chain.
const RecoveryDrillReplayChainLimit = 100

// RecurrenceWindow is the post-recovery observation window.
const RecurrenceWindow = 7 * 24 * time.Hour

// DrillOutcomeFacts are the durable database facts (kept separate so the
// outcome precedence stays pure-unit testable).
type DrillOutcomeFacts struct {
	RootCreatedAt      *time.Time
	RootStatus         string
	LatestDeadLetterID string
	LatestStatus       string
	AttemptCount       int
	ChainCapped        bool
	ReplayStartedAt    *time.Time
	RecoveredAt        *time.Time
	AcceptedItemAt     *time.Time
	AcceptedAuditAt    *time.Time
	RecurredAt         *time.Time
}

// DrillRecurrence is the recurrence projection.
type DrillRecurrence struct {
	Status       string  `json:"status"` // not_applicable | monitoring | clear | recurred
	WindowEndsAt *string `json:"windowEndsAt"`
	RecurredAt   *string `json:"recurredAt"`
}

// DrillOutcome is the locale-neutral projection the web renders.
type DrillOutcome struct {
	Status             string          `json:"status"`
	StartedAt          *string         `json:"startedAt"`
	CompletedAt        *string         `json:"completedAt"`
	ElapsedMs          *int64          `json:"elapsedMs"`
	Evidence           *string         `json:"evidence"`
	AttemptCount       int             `json:"attemptCount"`
	LatestDeadLetterID string          `json:"latestDeadLetterId"`
	ChainCapped        bool            `json:"chainCapped"`
	Recurrence         DrillRecurrence `json:"recurrence"`
}

func isoPtr(value *time.Time) *string {
	if value == nil {
		return nil
	}
	iso := value.UTC().Format("2006-01-02T15:04:05.000Z")
	return &iso
}

func earliest(left, right *time.Time) *time.Time {
	if left == nil {
		return right
	}
	if right == nil {
		return left
	}
	if left.Before(*right) || left.Equal(*right) {
		return left
	}
	return right
}

// BuildRecoveryDrillOutcome composes truthful status, duration, and
// recurrence from durable facts — the contract's precedence verbatim:
// capped → measurement_incomplete; recovered wins over accepted; an open
// latest entry is awaiting_action; a claimed-but-unresolved replay is
// replay_in_progress.
func BuildRecoveryDrillOutcome(facts DrillOutcomeFacts, now time.Time) DrillOutcome {
	acceptedAt := earliest(facts.AcceptedItemAt, facts.AcceptedAuditAt)
	recovered := facts.RecoveredAt != nil
	accepted := !recovered && (facts.AcceptedItemAt != nil ||
		(facts.AcceptedAuditAt != nil && facts.LatestStatus != "open") ||
		facts.LatestStatus == "resolved")

	var completedAt *time.Time
	if !facts.ChainCapped {
		if recovered {
			completedAt = facts.RecoveredAt
		} else if accepted {
			completedAt = acceptedAt
		}
	}

	status := "awaiting_action"
	switch {
	case facts.ChainCapped:
		status = "measurement_incomplete"
	case recovered:
		status = "recovered"
	case accepted:
		status = "accepted_loss"
	case facts.LatestStatus == "open":
		status = "awaiting_action"
	case facts.ReplayStartedAt != nil:
		status = "replay_in_progress"
	}

	recurrence := DrillRecurrence{Status: "not_applicable"}
	if facts.RecoveredAt != nil && !facts.ChainCapped {
		windowEnd := facts.RecoveredAt.Add(RecurrenceWindow)
		windowIso := isoPtr(&windowEnd)
		if facts.RecurredAt != nil {
			recurrence = DrillRecurrence{Status: "recurred", WindowEndsAt: windowIso, RecurredAt: isoPtr(facts.RecurredAt)}
		} else if now.After(windowEnd) || now.Equal(windowEnd) {
			recurrence = DrillRecurrence{Status: "clear", WindowEndsAt: windowIso}
		} else {
			recurrence = DrillRecurrence{Status: "monitoring", WindowEndsAt: windowIso}
		}
	}

	var elapsedMs *int64
	if facts.RootCreatedAt != nil && completedAt != nil {
		delta := max(completedAt.Sub(*facts.RootCreatedAt).Milliseconds(), 0)
		elapsedMs = &delta
	}

	var evidence *string
	if !facts.ChainCapped {
		if recovered {
			value := "terminal_impact"
			evidence = &value
		} else if accepted {
			value := "explicit_resolution"
			evidence = &value
		}
	}

	attemptCount := min(max(facts.AttemptCount, 1), RecoveryDrillReplayChainLimit)
	return DrillOutcome{
		Status: status, StartedAt: isoPtr(facts.RootCreatedAt),
		CompletedAt: isoPtr(completedAt), ElapsedMs: elapsedMs,
		Evidence: evidence, AttemptCount: attemptCount,
		LatestDeadLetterID: facts.LatestDeadLetterID,
		ChainCapped:        facts.ChainCapped, Recurrence: recurrence,
	}
}
