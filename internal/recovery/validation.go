// Recovery Validation composes the bounded, locale-neutral evidence dossier
// for server-authored recovery drills. It is intentionally pure: database
// facts enter as samples, while the API and export surfaces share the exact
// same denominators, timing statistics, and interpretation boundaries.
package recovery

import (
	"fmt"
	"math"
	"slices"
	"sort"
	"strings"
	"time"
)

// RecoveryValidationSampleLimit bounds one organization's report window.
const RecoveryValidationSampleLimit = 100

// ValidationResolutionMode deliberately withholds raw actor identifiers.
type ValidationResolutionMode string

const (
	ValidationResolutionOperator  ValidationResolutionMode = "operator"
	ValidationResolutionAutomated ValidationResolutionMode = "automated"
	ValidationResolutionUnknown   ValidationResolutionMode = "unknown"
)

// RecoveryValidationSample is one controlled drill and its durable outcome.
type RecoveryValidationSample struct {
	RunID          string                   `json:"runId"`
	RunCreatedAt   string                   `json:"runCreatedAt"`
	PackID         string                   `json:"packId"`
	FixtureID      string                   `json:"fixtureId"`
	FailureMode    string                   `json:"failureMode"`
	RecoveryPath   string                   `json:"recoveryPath"`
	ResolutionMode ValidationResolutionMode `json:"resolutionMode"`
	Outcome        *DrillOutcome            `json:"outcome"`
}

// RecoveryValidationBreakdown is one failure-mode or recovery-path group.
type RecoveryValidationBreakdown struct {
	Key                 string   `json:"key"`
	Total               int      `json:"total"`
	Completed           int      `json:"completed"`
	Recovered           int      `json:"recovered"`
	AcceptedLoss        int      `json:"acceptedLoss"`
	RecoveryRatePercent *float64 `json:"recoveryRatePercent"`
}

type RecoveryValidationTotals struct {
	Drills                int      `json:"drills"`
	Completed             int      `json:"completed"`
	Recovered             int      `json:"recovered"`
	AcceptedLoss          int      `json:"acceptedLoss"`
	AwaitingAction        int      `json:"awaitingAction"`
	ReplayInProgress      int      `json:"replayInProgress"`
	MeasurementIncomplete int      `json:"measurementIncomplete"`
	MissingEvidence       int      `json:"missingEvidence"`
	CompletionRatePercent *float64 `json:"completionRatePercent"`
	RecoveryRatePercent   *float64 `json:"recoveryRatePercent"`
}

type RecoveryValidationResolution struct {
	Operator                        int      `json:"operator"`
	Automated                       int      `json:"automated"`
	Unknown                         int      `json:"unknown"`
	OperatorInterventionRatePercent *float64 `json:"operatorInterventionRatePercent"`
}

type RecoveryValidationTiming struct {
	MedianElapsedMs  *int64 `json:"medianElapsedMs"`
	P90ElapsedMs     *int64 `json:"p90ElapsedMs"`
	AverageElapsedMs *int64 `json:"averageElapsedMs"`
	P95ElapsedMs     *int64 `json:"p95ElapsedMs"`
	SampleSize       int    `json:"sampleSize"`
}

// RecoveryValidationReport is the shared web/API/export contract.
type RecoveryValidationReport struct {
	GeneratedAt    string                        `json:"generatedAt"`
	WindowDays     int                           `json:"windowDays"`
	SampleLimit    int                           `json:"sampleLimit"`
	SampleCapped   bool                          `json:"sampleCapped"`
	Totals         RecoveryValidationTotals      `json:"totals"`
	Resolution     RecoveryValidationResolution  `json:"resolution"`
	Timing         RecoveryValidationTiming      `json:"timing"`
	ByFailureMode  []RecoveryValidationBreakdown `json:"byFailureMode"`
	ByRecoveryPath []RecoveryValidationBreakdown `json:"byRecoveryPath"`
	Samples        []RecoveryValidationSample    `json:"samples"`
}

func roundedPercent(numerator, denominator int) *float64 {
	if denominator <= 0 {
		return nil
	}
	value := math.Round(float64(numerator)/float64(denominator)*1000) / 10
	return &value
}

func percentile(sortedValues []int64, percentile float64) *int64 {
	if len(sortedValues) == 0 {
		return nil
	}
	index := max(0, int(math.Ceil(float64(len(sortedValues))*percentile))-1)
	value := sortedValues[index]
	return &value
}

func validationMedian(sortedValues []int64) *int64 {
	if len(sortedValues) == 0 {
		return nil
	}
	middle := len(sortedValues) / 2
	if len(sortedValues)%2 == 1 {
		value := sortedValues[middle]
		return &value
	}
	value := int64(math.Round(float64(sortedValues[middle-1]+sortedValues[middle]) / 2))
	return &value
}

func buildValidationBreakdown(
	samples []RecoveryValidationSample,
	key func(RecoveryValidationSample) string,
) []RecoveryValidationBreakdown {
	groups := make(map[string]RecoveryValidationBreakdown)
	for _, sample := range samples {
		groupKey := key(sample)
		group := groups[groupKey]
		group.Key = groupKey
		group.Total++
		if sample.Outcome != nil {
			switch sample.Outcome.Status {
			case "recovered":
				group.Completed++
				group.Recovered++
			case "accepted_loss":
				group.Completed++
				group.AcceptedLoss++
			}
		}
		groups[groupKey] = group
	}
	result := make([]RecoveryValidationBreakdown, 0, len(groups))
	for _, group := range groups {
		group.RecoveryRatePercent = roundedPercent(group.Recovered, group.Completed)
		result = append(result, group)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Total != result[j].Total {
			return result[i].Total > result[j].Total
		}
		return result[i].Key < result[j].Key
	})
	return result
}

// BuildRecoveryValidationReport composes the exact reference denominators.
func BuildRecoveryValidationReport(
	samples []RecoveryValidationSample,
	windowDays int,
	generatedAt time.Time,
	sampleCapped bool,
) RecoveryValidationReport {
	windowDays = min(90, max(1, windowDays))
	bounded := samples
	if len(bounded) > RecoveryValidationSampleLimit {
		bounded = bounded[:RecoveryValidationSampleLimit]
	}
	// Own the slice so callers cannot mutate the report after composition and
	// keep the empty wire shape as [] rather than null.
	boundedCopy := make([]RecoveryValidationSample, len(bounded))
	copy(boundedCopy, bounded)
	bounded = boundedCopy

	totals := RecoveryValidationTotals{Drills: len(bounded)}
	resolution := RecoveryValidationResolution{}
	elapsed := make([]int64, 0, len(bounded))
	for _, sample := range bounded {
		if sample.Outcome == nil {
			totals.MissingEvidence++
			continue
		}
		switch sample.Outcome.Status {
		case "recovered":
			totals.Recovered++
		case "accepted_loss":
			totals.AcceptedLoss++
		case "awaiting_action":
			totals.AwaitingAction++
		case "replay_in_progress":
			totals.ReplayInProgress++
		default:
			totals.MeasurementIncomplete++
		}
		if sample.Outcome.Status == "recovered" || sample.Outcome.Status == "accepted_loss" {
			switch sample.ResolutionMode {
			case ValidationResolutionOperator:
				resolution.Operator++
			case ValidationResolutionAutomated:
				resolution.Automated++
			default:
				resolution.Unknown++
			}
		}
		if sample.Outcome.Status == "recovered" && sample.Outcome.ElapsedMs != nil {
			elapsed = append(elapsed, max(*sample.Outcome.ElapsedMs, 0))
		}
	}

	totals.Completed = totals.Recovered + totals.AcceptedLoss
	totals.CompletionRatePercent = roundedPercent(totals.Completed, totals.Drills)
	totals.RecoveryRatePercent = roundedPercent(totals.Recovered, totals.Completed)
	resolution.OperatorInterventionRatePercent = roundedPercent(
		resolution.Operator,
		resolution.Operator+resolution.Automated,
	)
	slices.Sort(elapsed)
	var average *int64
	if len(elapsed) > 0 {
		var total int64
		for _, value := range elapsed {
			total += value
		}
		value := int64(math.Round(float64(total) / float64(len(elapsed))))
		average = &value
	}

	return RecoveryValidationReport{
		GeneratedAt:  generatedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
		WindowDays:   windowDays,
		SampleLimit:  RecoveryValidationSampleLimit,
		SampleCapped: sampleCapped || len(samples) > RecoveryValidationSampleLimit,
		Totals:       totals,
		Resolution:   resolution,
		Timing: RecoveryValidationTiming{
			MedianElapsedMs: validationMedian(elapsed), P90ElapsedMs: percentile(elapsed, 0.9),
			AverageElapsedMs: average, P95ElapsedMs: percentile(elapsed, 0.95), SampleSize: len(elapsed),
		},
		ByFailureMode:  buildValidationBreakdown(bounded, func(sample RecoveryValidationSample) string { return sample.FailureMode }),
		ByRecoveryPath: buildValidationBreakdown(bounded, func(sample RecoveryValidationSample) string { return sample.RecoveryPath }),
		Samples:        bounded,
	}
}

func validationPercent(value *float64) string {
	if value == nil {
		return "not enough completed evidence"
	}
	return fmt.Sprintf("%.1f%%", *value)
}

func validationDuration(value *int64) string {
	if value == nil {
		return "not enough completed evidence"
	}
	if *value < 1000 {
		return fmt.Sprintf("%d ms", *value)
	}
	seconds := int(math.Round(float64(*value) / 1000))
	hours, minutes, seconds := seconds/3600, (seconds%3600)/60, seconds%60
	parts := make([]string, 0, 3)
	if hours > 0 {
		parts = append(parts, fmt.Sprintf("%dh", hours))
	}
	if minutes > 0 {
		parts = append(parts, fmt.Sprintf("%dm", minutes))
	}
	if seconds > 0 || len(parts) == 0 {
		parts = append(parts, fmt.Sprintf("%ds", seconds))
	}
	return strings.Join(parts, " ")
}

func markdownCell(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, "|", `\|`)
	value = strings.NewReplacer("\r", " ", "\n", " ").Replace(value)
	return value
}

func appendValidationBreakdown(builder *strings.Builder, title string, entries []RecoveryValidationBreakdown) {
	fmt.Fprintf(builder, "## %s\n\n", title)
	if len(entries) == 0 {
		builder.WriteString("No controlled drill evidence in this window.\n\n")
		return
	}
	builder.WriteString("| Category | Drills | Completed | Recovered | Accepted loss | Recovery rate |\n")
	builder.WriteString("| --- | ---: | ---: | ---: | ---: | ---: |\n")
	for _, entry := range entries {
		fmt.Fprintf(builder, "| %s | %d | %d | %d | %d | %s |\n", markdownCell(entry.Key), entry.Total,
			entry.Completed, entry.Recovered, entry.AcceptedLoss, validationPercent(entry.RecoveryRatePercent))
	}
	builder.WriteByte('\n')
}

// BuildRecoveryValidationMarkdown renders the stable, honest export.
func BuildRecoveryValidationMarkdown(orgID string, report RecoveryValidationReport) string {
	var builder strings.Builder
	builder.Grow(4096 + len(report.Samples)*160)
	fmt.Fprintf(&builder, "# Recovery Validation Dossier — last %d days\n\n", report.WindowDays)
	builder.WriteString("> **Scope:** controlled recovery drills for one organization. This dossier does not measure external partner count or setup time and is not proof that private-beta acceptance is complete.\n\n")
	fmt.Fprintf(&builder, "_Organization: %s · Generated: %s_\n\n", markdownCell(orgID), report.GeneratedAt)
	builder.WriteString("## Evidence summary\n\n")
	fmt.Fprintf(&builder, "- **Controlled drills observed**: %d", report.Totals.Drills)
	if report.SampleCapped {
		fmt.Fprintf(&builder, " (newest %d; sample capped)", report.SampleLimit)
	}
	builder.WriteByte('\n')
	fmt.Fprintf(&builder, "- **Completed outcomes**: %d/%d (%s)\n", report.Totals.Completed, report.Totals.Drills, validationPercent(report.Totals.CompletionRatePercent))
	fmt.Fprintf(&builder, "- **Recovery rate among completed outcomes**: %d/%d (%s)\n", report.Totals.Recovered, report.Totals.Completed, validationPercent(report.Totals.RecoveryRatePercent))
	fmt.Fprintf(&builder, "- **Accepted loss**: %d\n", report.Totals.AcceptedLoss)
	fmt.Fprintf(&builder, "- **Awaiting action / replay in progress**: %d / %d\n", report.Totals.AwaitingAction, report.Totals.ReplayInProgress)
	fmt.Fprintf(&builder, "- **Incomplete / missing evidence**: %d / %d\n", report.Totals.MeasurementIncomplete, report.Totals.MissingEvidence)
	fmt.Fprintf(&builder, "- **Median measured recovery time**: %s (recovered outcomes; n=%d)\n", validationDuration(report.Timing.MedianElapsedMs), report.Timing.SampleSize)
	fmt.Fprintf(&builder, "- **p90 measured recovery time**: %s (recovered outcomes; n=%d)\n", validationDuration(report.Timing.P90ElapsedMs), report.Timing.SampleSize)
	fmt.Fprintf(&builder, "- **Average / p95 measured recovery time**: %s / %s (recovered outcomes; n=%d)\n\n", validationDuration(report.Timing.AverageElapsedMs), validationDuration(report.Timing.P95ElapsedMs), report.Timing.SampleSize)
	builder.WriteString("## Resolution ownership\n\n")
	fmt.Fprintf(&builder, "- **Operator-resolved**: %d\n", report.Resolution.Operator)
	fmt.Fprintf(&builder, "- **Automated**: %d\n", report.Resolution.Automated)
	fmt.Fprintf(&builder, "- **Unknown actor**: %d\n", report.Resolution.Unknown)
	fmt.Fprintf(&builder, "- **Operator intervention among known actors**: %s\n\n", validationPercent(report.Resolution.OperatorInterventionRatePercent))
	appendValidationBreakdown(&builder, "Failure-mode coverage", report.ByFailureMode)
	appendValidationBreakdown(&builder, "Recovery-path coverage", report.ByRecoveryPath)
	builder.WriteString("## Drill evidence\n\n")
	if len(report.Samples) == 0 {
		builder.WriteString("No controlled drill evidence in this window.\n\n")
	} else {
		builder.WriteString("| Run | Pack / fixture | Failure mode | Recovery path | Outcome | Resolution | Elapsed | Evidence |\n")
		builder.WriteString("| --- | --- | --- | --- | --- | --- | ---: | --- |\n")
		for _, sample := range report.Samples {
			status, evidence := "missing_evidence", "none"
			var elapsed *int64
			if sample.Outcome != nil {
				status, elapsed = sample.Outcome.Status, sample.Outcome.ElapsedMs
				if sample.Outcome.Evidence != nil {
					evidence = *sample.Outcome.Evidence
				}
			}
			fmt.Fprintf(&builder, "| %s | %s | %s | %s | %s | %s | %s | %s |\n",
				markdownCell(sample.RunID), markdownCell(sample.PackID+" / "+sample.FixtureID),
				markdownCell(sample.FailureMode), markdownCell(sample.RecoveryPath), status,
				sample.ResolutionMode, validationDuration(elapsed), evidence)
		}
		builder.WriteByte('\n')
	}
	builder.WriteString("## Interpretation boundaries\n\n")
	builder.WriteString("- Recovery requires an immutable terminal impact event; enqueueing a replay is not recovery.\n")
	builder.WriteString("- Recovery rate uses completed outcomes only: recovered / (recovered + accepted loss). Pending, incomplete, and missing evidence remain visible but stay out of that denominator.\n")
	builder.WriteString("- Recovery-time statistics use verified recovered outcomes only; accepted loss is not recovery-time evidence.\n")
	builder.WriteString("- Operator intervention excludes completed outcomes whose actor cannot be identified.\n")
	builder.WriteString("- Partner recruitment, production onboarding time, and willingness-to-pay remain external validation evidence.\n")
	return builder.String()
}
