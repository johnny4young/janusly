// Approval waiting-time policy is pure workflow logic: authoring validation,
// executor resolution, and checkpoint materialization must share one grammar.
package domain

import (
	"maps"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	maxJSTimestampMillis = int64(8_640_000_000_000_000)
	maxJSSafeInteger     = float64(9_007_199_254_740_991)
)

var approvalInstantPattern = regexp.MustCompile(
	`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$`,
)

// WaitingConfigError is the stable workflow-validation/executor error shape.
type WaitingConfigError struct {
	Code    string
	Message string
}

func (e *WaitingConfigError) Error() string { return e.Message }

// ApprovalWaitingConfig is the normalized approval checkpoint policy. A
// relative timeout remains relative until the engine commits the waiting
// checkpoint, so executor/queue latency never consumes the decision window.
type ApprovalWaitingConfig struct {
	Assignee          string
	RelativeTimeoutMS *int64
	DeadlineAt        string
	DelayMS           int64
	OnTimeout         string
	EscalateTo        string
}

// ResolveApprovalWaitingConfig ports the Node baseline's exact optional
// ownership, deadline XOR, timeout-policy, and escalation contract.
func ResolveApprovalWaitingConfig(config map[string]any, now time.Time) (ApprovalWaitingConfig, error) {
	assignee := optionalWaitingLabel(config["assignee"])
	escalateTo := optionalWaitingLabel(config["escalateTo"])
	_, hasTimeout := config["decisionTimeoutMs"]
	_, hasUntil := config["until"]

	if hasTimeout && hasUntil {
		return ApprovalWaitingConfig{}, &WaitingConfigError{
			Code:    "approval_conflicting_deadline",
			Message: "Approval node accepts either config.decisionTimeoutMs or config.until, not both",
		}
	}

	rawPolicy, hasPolicy := config["onTimeout"]
	policy, policyOK := rawPolicy.(string)
	if hasPolicy && (!policyOK || (policy != "fail" && policy != "auto_reject" && policy != "escalate")) {
		return ApprovalWaitingConfig{}, &WaitingConfigError{
			Code:    "approval_invalid_timeout_policy",
			Message: "Approval node config.onTimeout must be fail, auto_reject, or escalate",
		}
	}

	if !hasTimeout && !hasUntil {
		if hasPolicy {
			return ApprovalWaitingConfig{}, &WaitingConfigError{
				Code:    "approval_timeout_policy_without_deadline",
				Message: "Approval node config.onTimeout requires config.decisionTimeoutMs or config.until",
			}
		}
		if escalateTo != "" {
			return ApprovalWaitingConfig{}, &WaitingConfigError{
				Code:    "approval_escalation_without_policy",
				Message: "Approval node config.escalateTo requires onTimeout: escalate and a deadline",
			}
		}
		return ApprovalWaitingConfig{Assignee: assignee}, nil
	}

	resolved := ApprovalWaitingConfig{Assignee: assignee}
	if hasTimeout {
		timeout, ok := safePositiveInteger(config["decisionTimeoutMs"])
		if !ok {
			return ApprovalWaitingConfig{}, &WaitingConfigError{
				Code:    "approval_invalid_timeout",
				Message: "Approval node config.decisionTimeoutMs must be a positive safe integer",
			}
		}
		deadlineMillis := now.UnixMilli() + timeout
		if deadlineMillis < -maxJSTimestampMillis || deadlineMillis > maxJSTimestampMillis {
			return ApprovalWaitingConfig{}, &WaitingConfigError{
				Code:    "approval_invalid_timeout",
				Message: "Approval node config.decisionTimeoutMs must resolve to a supported date-time",
			}
		}
		resolved.RelativeTimeoutMS = &timeout
	} else {
		until, _ := config["until"].(string)
		deadline := ParseAbsoluteInstant(until)
		if deadline == nil {
			return ApprovalWaitingConfig{}, &WaitingConfigError{
				Code:    "approval_invalid_until",
				Message: "Approval node config.until must be an ISO 8601 date-time with an explicit timezone",
			}
		}
		resolved.DeadlineAt = FormatWaitingInstant(*deadline)
		resolved.DelayMS = max(deadline.UnixMilli()-now.UnixMilli(), 0)
	}

	if !hasPolicy {
		policy = "fail"
	}
	if policy == "escalate" && escalateTo == "" {
		return ApprovalWaitingConfig{}, &WaitingConfigError{
			Code:    "approval_escalation_missing_assignee",
			Message: "Approval node onTimeout: escalate requires a non-empty config.escalateTo",
		}
	}
	if policy != "escalate" && escalateTo != "" {
		return ApprovalWaitingConfig{}, &WaitingConfigError{
			Code:    "approval_escalation_without_policy",
			Message: "Approval node config.escalateTo requires onTimeout: escalate",
		}
	}
	resolved.OnTimeout = policy
	resolved.EscalateTo = escalateTo
	return resolved, nil
}

// MaterializeApprovalWaitingMetadata starts a relative deadline from the
// durable waiting transition rather than executor work that happened before
// the checkpoint was available to operators.
func MaterializeApprovalWaitingMetadata(metadata map[string]any, checkpoint time.Time) map[string]any {
	result := make(map[string]any, len(metadata)+2)
	maps.Copy(result, metadata)
	if result["kind"] != "approval" {
		return result
	}
	if _, present := result["deadlineAt"]; present {
		return result
	}
	timeout, ok := safePositiveInteger(result["decisionTimeoutMs"])
	if !ok {
		return result
	}
	deadlineMillis := checkpoint.UnixMilli() + timeout
	if deadlineMillis < -maxJSTimestampMillis || deadlineMillis > maxJSTimestampMillis {
		return result
	}
	result["deadlineAt"] = FormatWaitingInstant(time.UnixMilli(deadlineMillis))
	result["delayMs"] = timeout
	return result
}

// ParseAbsoluteInstant accepts only unambiguous ISO-8601 instants with an
// explicit timezone and validates calendar fields before Go can normalize
// them into a different date.
func ParseAbsoluteInstant(value string) *time.Time {
	match := approvalInstantPattern.FindStringSubmatch(strings.TrimSpace(value))
	if match == nil {
		return nil
	}
	year := waitingInt(match[1])
	month := waitingInt(match[2])
	day := waitingInt(match[3])
	hour := waitingInt(match[4])
	minute := waitingInt(match[5])
	second := 0
	if match[6] != "" {
		second = waitingInt(match[6])
	}
	offsetHour, offsetMinute := 0, 0
	if match[9] != "" {
		offsetHour = waitingInt(match[10])
		offsetMinute = waitingInt(match[11])
	}
	if month < 1 || month > 12 || day < 1 || day > waitingDaysInMonth(year, month) ||
		hour > 23 || minute > 59 || second > 59 ||
		(match[8] != "Z" && (offsetHour > 23 || offsetMinute > 59)) {
		return nil
	}
	millis := 0
	if match[7] != "" {
		fraction := match[7] + strings.Repeat("0", 3-len(match[7]))
		millis = waitingInt(fraction)
	}
	offsetSeconds := 0
	if match[8] != "Z" {
		offsetSeconds = offsetHour*3600 + offsetMinute*60
		if match[9] == "-" {
			offsetSeconds = -offsetSeconds
		}
	}
	instant := time.Date(year, time.Month(month), day, hour, minute, second,
		millis*int(time.Millisecond), time.FixedZone("", offsetSeconds)).UTC()
	return &instant
}

// FormatWaitingInstant matches Date.toISOString for the four-digit years
// accepted by the persisted approval/wait_until grammar.
func FormatWaitingInstant(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

func optionalWaitingLabel(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func safePositiveInteger(value any) (int64, bool) {
	number, ok := waitingNumber(value)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number <= 0 ||
		math.Trunc(number) != number || number > maxJSSafeInteger {
		return 0, false
	}
	return int64(number), true
}

func waitingNumber(value any) (float64, bool) {
	switch number := value.(type) {
	case float64:
		return number, true
	case float32:
		return float64(number), true
	case int:
		return float64(number), true
	case int64:
		return float64(number), true
	case int32:
		return float64(number), true
	default:
		return 0, false
	}
}

func waitingInt(value string) int {
	parsed, _ := strconv.Atoi(value)
	return parsed
}

func waitingDaysInMonth(year, month int) int {
	if month == 2 {
		if year%4 == 0 && (year%100 != 0 || year%400 == 0) {
			return 29
		}
		return 28
	}
	switch month {
	case 4, 6, 9, 11:
		return 30
	default:
		return 31
	}
}
