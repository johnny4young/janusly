// Waiting-node executors and their time grammar, ported from the reference
// (wait-until.ts, approval-timeout.ts, waiting-time.ts, iso-duration.ts).
// wait_until pauses for an ISO 8601 duration or absolute instant; approval
// pauses indefinitely for a human decision. Both return a Waiting value —
// the engine owns the durable checkpoint and the wake-up clock.
package executors

import (
	"context"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/johnny4young/janusly/go/internal/domain"
)

// Waiting is the executor signal for a pause: the engine persists the node
// as waiting with this metadata and, when WakeAt is set, schedules the
// wake-up that auto-resumes it.
type Waiting struct {
	Reason   string
	Metadata map[string]any
	WakeAt   *time.Time
}

// ConfigError keeps the executor-facing name while sharing the pure workflow
// grammar with authoring validation.
type ConfigError = domain.WaitingConfigError

// Approximations inherited from the reference: year = 365 days, month = 30
// days — calendar-aware arithmetic is intentionally out of scope.
const (
	dayMs    = 86_400_000
	hourMs   = 3_600_000
	minuteMs = 60_000
	secondMs = 1_000
	yearMs   = 365 * dayMs
	monthMs  = 30 * dayMs
)

var isoDurationPattern = regexp.MustCompile(
	`^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$`,
)

// ParseISODuration converts an ISO 8601 duration to milliseconds; nil for
// malformed input, the bare P, or PT. Decimals allowed, negatives not.
func ParseISODuration(value string) *float64 {
	match := isoDurationPattern.FindStringSubmatch(value)
	if match == nil {
		return nil
	}
	empty := true
	for _, group := range match[1:] {
		if group != "" {
			empty = false
		}
	}
	if empty {
		return nil
	}
	total := durationComponent(match[1], yearMs) +
		durationComponent(match[2], monthMs) +
		durationComponent(match[3], dayMs) +
		durationComponent(match[4], hourMs) +
		durationComponent(match[5], minuteMs) +
		durationComponent(match[6], secondMs)
	return &total
}

func durationComponent(text string, unitMs float64) float64 {
	if text == "" {
		return 0
	}
	n, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return 0
	}
	return n * unitMs
}

// ParseAbsoluteInstant parses an unambiguous ISO 8601 instant (explicit
// timezone required) with the reference's field validation; nil on invalid.
func ParseAbsoluteInstant(value string) *time.Time {
	return domain.ParseAbsoluteInstant(value)
}

// waitUntilSchedule mirrors the reference's resolved shape.
type waitUntilSchedule struct {
	delayMs float64
	wakeAt  time.Time
	source  string
}

// resolveWaitUntilSchedule ports the reference resolver with its exact
// codes and messages: duration XOR until, positive duration, explicit
// timezone; a past absolute instant resumes immediately.
func resolveWaitUntilSchedule(config map[string]any, now time.Time) (*waitUntilSchedule, error) {
	_, hasDuration := config["duration"]
	_, hasUntil := config["until"]
	if hasDuration && hasUntil {
		return nil, &ConfigError{Code: "wait_until_conflicting_time",
			Message: "wait_until accepts either config.duration or config.until, not both"}
	}
	if !hasDuration && !hasUntil {
		return nil, &ConfigError{Code: "wait_until_missing_duration",
			Message: "wait_until requires config.duration or config.until"}
	}
	if hasDuration {
		text, ok := config["duration"].(string)
		if !ok || strings.TrimSpace(text) == "" {
			return nil, &ConfigError{Code: "wait_until_invalid_duration",
				Message: "wait_until.duration must be a valid ISO 8601 duration"}
		}
		delay := ParseISODuration(text)
		if delay == nil {
			return nil, &ConfigError{Code: "wait_until_invalid_duration",
				Message: fmt.Sprintf("wait_until.duration must be a valid ISO 8601 duration, got: %s", text)}
		}
		if *delay <= 0 {
			return nil, &ConfigError{Code: "wait_until_non_positive_duration",
				Message: fmt.Sprintf("wait_until.duration must resolve to a positive number of milliseconds, got: %v", *delay)}
		}
		wakeAt := now.Add(time.Duration(*delay) * time.Millisecond)
		return &waitUntilSchedule{delayMs: *delay, wakeAt: wakeAt, source: "duration"}, nil
	}
	text, _ := config["until"].(string)
	instant := ParseAbsoluteInstant(text)
	if instant == nil {
		return nil, &ConfigError{Code: "wait_until_invalid_until",
			Message: "wait_until.until must be an ISO 8601 date-time with an explicit timezone"}
	}
	delay := float64(instant.Sub(now).Milliseconds())
	if delay < 0 {
		delay = 0
	}
	return &waitUntilSchedule{delayMs: delay, wakeAt: *instant, source: "until"}, nil
}

// executeWaitUntil returns the waiting checkpoint with the timer metadata;
// the engine schedules the wake-up from WakeAt.
func executeWaitUntil(_ context.Context, in Input) (any, error) {
	schedule, err := resolveWaitUntilSchedule(in.Config, time.Now())
	if err != nil {
		return nil, err
	}
	wakeAt := schedule.wakeAt
	return Waiting{
		Reason: "Waiting for scheduled time",
		Metadata: map[string]any{
			"kind":       "timer",
			"wakeAt":     schedule.wakeAt.UTC().Format("2006-01-02T15:04:05.000Z"),
			"durationMs": schedule.delayMs,
			"source":     schedule.source,
		},
		WakeAt: &wakeAt,
	}, nil
}

// executeWebhook persists the legacy external-resume checkpoint. The
// authenticated /resume route supplies the webhook payload later; the engine
// copies that payload into this node's output before releasing downstream work.
func executeWebhook(_ context.Context, in Input) (any, error) {
	return Waiting{
		Reason: "Waiting for external webhook resume",
		Metadata: map[string]any{
			"kind":        "webhook",
			"resumeToken": in.RunID + ":" + in.NodeID,
		},
	}, nil
}

// executeApproval persists the reference's indefinite or bounded human
// decision checkpoint. Relative deadlines are deliberately materialized by
// the engine from the checkpoint timestamp, not this executor's start clock.
func executeApproval(_ context.Context, in Input) (any, error) {
	resolved, err := domain.ResolveApprovalWaitingConfig(in.Config, time.Now())
	if err != nil {
		return nil, err
	}
	metadata := map[string]any{
		"kind":        "approval",
		"resumeToken": in.RunID + ":" + in.NodeID,
	}
	if title := trimmedString(in.Config["title"]); title != "" {
		metadata["title"] = title
	} else if message := trimmedString(in.Config["message"]); message != "" {
		metadata["title"] = message
	}
	if description := trimmedString(in.Config["description"]); description != "" {
		metadata["description"] = description
	}
	if resolved.Assignee != "" {
		metadata["assignee"] = resolved.Assignee
	}
	var wakeAt *time.Time
	if resolved.RelativeTimeoutMS != nil {
		metadata["decisionTimeoutMs"] = *resolved.RelativeTimeoutMS
		metadata["onTimeout"] = resolved.OnTimeout
	} else if resolved.DeadlineAt != "" {
		metadata["deadlineAt"] = resolved.DeadlineAt
		metadata["delayMs"] = resolved.DelayMS
		metadata["onTimeout"] = resolved.OnTimeout
		wakeAt = domain.ParseAbsoluteInstant(resolved.DeadlineAt)
	}
	if resolved.EscalateTo != "" {
		metadata["escalateTo"] = resolved.EscalateTo
	}
	return Waiting{Reason: "Waiting for human approval", Metadata: metadata, WakeAt: wakeAt}, nil
}

// executeHumanForm pauses like approval but resumes with STRUCTURED
// input as the node output. The executor validates the declared schema
// shape (a non-empty object schema — the reference's top AI-generation
// failure is an empty schema) and pauses with a fields projection; the
// ENGINE injects the signed resume token when it persists the waiting
// checkpoint (signing needs org policy + the dedicated secret, which the
// executor deliberately cannot see).
func executeHumanForm(_ context.Context, in Input) (any, error) {
	schema, _ := in.Config["schema"].(map[string]any)
	properties, _ := schema["properties"].(map[string]any)
	inputSchema, validSchema := domain.ParseInputSchemaValue(schema)
	if !validSchema || len(properties) == 0 {
		return nil, &ConfigError{Code: "human_form_schema_required",
			Message: "human_form requires config.schema with at least one property"}
	}
	if schemaType, ok := schema["type"].(string); ok && schemaType != "object" {
		return nil, &ConfigError{Code: "human_form_schema_required",
			Message: "human_form schema must be an object schema"}
	}
	fields := make([]map[string]any, 0, len(properties))
	names := slices.Sorted(maps.Keys(properties))
	requiredSet := map[string]bool{}
	if required, ok := schema["required"].([]any); ok {
		for _, entry := range required {
			if name, ok := entry.(string); ok {
				requiredSet[name] = true
			}
		}
	}
	for _, name := range names {
		propSchema, _ := properties[name].(map[string]any)
		fieldType, _ := propSchema["type"].(string)
		if fieldType == "" {
			fieldType = "string"
		}
		fields = append(fields, map[string]any{
			"name": name, "type": fieldType, "required": requiredSet[name],
		})
	}
	metadata := map[string]any{
		"kind":   "human_form",
		"title":  "Human input required",
		"schema": schema,
		"fields": fields,
	}
	if title := trimmedString(in.Config["title"]); title != "" {
		metadata["title"] = title
	}
	if description := trimmedString(in.Config["description"]); description != "" {
		metadata["description"] = description
	}
	if initialValues, present := in.Config["initialValues"]; present {
		if errs := domain.ValidateInputValue(inputSchema, initialValues, "$"); len(errs) > 0 {
			return nil, fmt.Errorf("human_form.initialValues invalid: %s", strings.Join(errs, "; "))
		}
		metadata["initialValues"] = initialValues
	}
	return Waiting{Reason: "Waiting for form submission", Metadata: metadata}, nil
}

func trimmedString(value any) string {
	s, _ := value.(string)
	return strings.TrimSpace(s)
}
