package domain

import (
	"testing"
	"time"
)

var approvalTestNow = time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)

func TestResolveApprovalWaitingConfig(t *testing.T) {
	indefinite, err := ResolveApprovalWaitingConfig(map[string]any{"assignee": " operator-1 "}, approvalTestNow)
	if err != nil || indefinite.Assignee != "operator-1" || indefinite.OnTimeout != "" {
		t.Fatalf("indefinite ownership: %+v err=%v", indefinite, err)
	}

	relative, err := ResolveApprovalWaitingConfig(map[string]any{"decisionTimeoutMs": float64(60_000)}, approvalTestNow)
	if err != nil || relative.RelativeTimeoutMS == nil || *relative.RelativeTimeoutMS != 60_000 ||
		relative.OnTimeout != "fail" || relative.DeadlineAt != "" {
		t.Fatalf("relative deadline: %+v err=%v", relative, err)
	}

	absolute, err := ResolveApprovalWaitingConfig(map[string]any{
		"until": "2026-07-14T11:59:00-00:00", "onTimeout": "escalate",
		"assignee": "tier-1", "escalateTo": "tier-2",
	}, approvalTestNow)
	if err != nil || absolute.DeadlineAt != "2026-07-14T11:59:00.000Z" ||
		absolute.DelayMS != 0 || absolute.OnTimeout != "escalate" || absolute.EscalateTo != "tier-2" {
		t.Fatalf("absolute escalation: %+v err=%v", absolute, err)
	}
}

func TestApprovalWaitingConfigErrors(t *testing.T) {
	cases := []struct {
		name   string
		config map[string]any
		code   string
	}{
		{"conflicting deadline", map[string]any{"decisionTimeoutMs": float64(1), "until": "2026-07-14T12:05:00Z"}, "approval_conflicting_deadline"},
		{"invalid policy", map[string]any{"decisionTimeoutMs": float64(1), "onTimeout": "resume"}, "approval_invalid_timeout_policy"},
		{"policy without deadline", map[string]any{"onTimeout": "fail"}, "approval_timeout_policy_without_deadline"},
		{"invalid timeout", map[string]any{"decisionTimeoutMs": float64(1.5)}, "approval_invalid_timeout"},
		{"invalid until", map[string]any{"until": "2026-07-14 12:05"}, "approval_invalid_until"},
		{"missing escalation", map[string]any{"decisionTimeoutMs": float64(1), "onTimeout": "escalate"}, "approval_escalation_missing_assignee"},
		{"orphan escalation", map[string]any{"decisionTimeoutMs": float64(1), "escalateTo": "ops"}, "approval_escalation_without_policy"},
		{"unsupported date", map[string]any{"decisionTimeoutMs": float64(9_007_199_254_740_991)}, "approval_invalid_timeout"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			_, err := ResolveApprovalWaitingConfig(test.config, approvalTestNow)
			configErr, ok := err.(*WaitingConfigError)
			if !ok || configErr.Code != test.code {
				t.Fatalf("code = %v, want %s", err, test.code)
			}
		})
	}
}

func TestMaterializeApprovalWaitingMetadata(t *testing.T) {
	metadata := MaterializeApprovalWaitingMetadata(map[string]any{
		"kind": "approval", "decisionTimeoutMs": float64(60_000), "onTimeout": "fail",
	}, approvalTestNow)
	if metadata["deadlineAt"] != "2026-07-14T12:01:00.000Z" || metadata["delayMs"] != int64(60_000) {
		t.Fatalf("checkpoint deadline: %+v", metadata)
	}
}

func TestApprovalValidationUsesSharedGrammar(t *testing.T) {
	wf := &Workflow{Nodes: []Node{{
		ID: "gate", Type: "approval",
		Config: map[string]any{"decisionTimeoutMs": float64(1), "onTimeout": "escalate"},
	}}}
	result := Validate(wf, PermissiveExpressions)
	if result.Valid || len(result.Issues) != 1 || result.Issues[0].Code != "approval_escalation_missing_assignee" {
		t.Fatalf("approval validation must expose stable code: %+v", result)
	}
}
