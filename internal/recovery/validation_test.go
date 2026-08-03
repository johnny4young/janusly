package recovery

import (
	"strings"
	"testing"
	"time"
)

func validationOutcome(status string, elapsed *int64) *DrillOutcome {
	return &DrillOutcome{Status: status, ElapsedMs: elapsed}
}

func TestBuildRecoveryValidationReport(t *testing.T) {
	now := time.Date(2026, 7, 21, 12, 0, 0, 0, time.UTC)
	samples := []RecoveryValidationSample{
		{RunID: "run-recovered", FailureMode: "secret_missing", RecoveryPath: "runtime_failure", ResolutionMode: ValidationResolutionOperator, Outcome: validationOutcome("recovered", new(int64(1_000)))},
		{RunID: "run-accepted", FailureMode: "secret_missing", RecoveryPath: "runtime_failure", ResolutionMode: ValidationResolutionAutomated, Outcome: validationOutcome("accepted_loss", new(int64(9_999)))},
		{RunID: "run-awaiting", FailureMode: "worker_stalled", RecoveryPath: "stalled_node_reaper", ResolutionMode: ValidationResolutionUnknown, Outcome: validationOutcome("awaiting_action", nil)},
		{RunID: "run-incomplete", FailureMode: "worker_stalled", RecoveryPath: "stalled_node_reaper", ResolutionMode: ValidationResolutionUnknown, Outcome: validationOutcome("measurement_incomplete", nil)},
		{RunID: "run-missing", FailureMode: "unknown", RecoveryPath: "runtime_failure", ResolutionMode: ValidationResolutionUnknown, Outcome: nil},
	}

	report := BuildRecoveryValidationReport(samples, 365, now, false)
	if report.WindowDays != 90 || report.SampleLimit != RecoveryValidationSampleLimit || report.SampleCapped {
		t.Fatalf("window/cap: %+v", report)
	}
	if report.Totals.Drills != 5 || report.Totals.Completed != 2 || report.Totals.Recovered != 1 ||
		report.Totals.AcceptedLoss != 1 || report.Totals.AwaitingAction != 1 ||
		report.Totals.MeasurementIncomplete != 1 || report.Totals.MissingEvidence != 1 {
		t.Fatalf("totals: %+v", report.Totals)
	}
	if report.Totals.CompletionRatePercent == nil || *report.Totals.CompletionRatePercent != 40 ||
		report.Totals.RecoveryRatePercent == nil || *report.Totals.RecoveryRatePercent != 50 {
		t.Fatalf("rates: %+v", report.Totals)
	}
	if report.Resolution.Operator != 1 || report.Resolution.Automated != 1 || report.Resolution.Unknown != 0 ||
		report.Resolution.OperatorInterventionRatePercent == nil || *report.Resolution.OperatorInterventionRatePercent != 50 {
		t.Fatalf("resolution: %+v", report.Resolution)
	}
	if report.Timing.SampleSize != 1 || report.Timing.MedianElapsedMs == nil || *report.Timing.MedianElapsedMs != 1_000 ||
		report.Timing.P90ElapsedMs == nil || *report.Timing.P90ElapsedMs != 1_000 {
		t.Fatalf("timing: %+v", report.Timing)
	}
	if len(report.ByFailureMode) != 3 || report.ByFailureMode[0].Key != "secret_missing" || report.ByFailureMode[0].Total != 2 {
		t.Fatalf("failure breakdown: %+v", report.ByFailureMode)
	}
	if len(report.ByRecoveryPath) != 2 || report.ByRecoveryPath[0].Key != "runtime_failure" || report.ByRecoveryPath[0].Total != 3 {
		t.Fatalf("path breakdown: %+v", report.ByRecoveryPath)
	}

	markdown := BuildRecoveryValidationMarkdown("org|private\n", report)
	for _, expected := range []string{
		"Recovery rate among completed outcomes**: 1/2 (50.0%)",
		"org\\|private ",
		"accepted_loss",
		"Partner recruitment",
	} {
		if !strings.Contains(markdown, expected) {
			t.Fatalf("markdown missing %q:\n%s", expected, markdown)
		}
	}
}

func TestBuildRecoveryValidationReportCapsSamples(t *testing.T) {
	samples := make([]RecoveryValidationSample, RecoveryValidationSampleLimit+1)
	for i := range samples {
		samples[i] = RecoveryValidationSample{RunID: "run", FailureMode: "unknown", RecoveryPath: "runtime_failure"}
	}
	report := BuildRecoveryValidationReport(samples, 0, time.Unix(0, 0), false)
	if report.WindowDays != 1 || !report.SampleCapped || len(report.Samples) != RecoveryValidationSampleLimit || report.Totals.Drills != RecoveryValidationSampleLimit {
		t.Fatalf("bounded report: %+v", report)
	}
}
