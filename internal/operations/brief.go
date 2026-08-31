// Package operations owns Janusly's bounded, deterministic operator brief.
// UI and MCP consume the same tenant-scoped read model; optional AI may enrich
// copy elsewhere but cannot change ranking, authority, targets, or evidence.
package operations

import (
	"sort"
	"time"

	"github.com/johnny4young/janusly/internal/store"
)

const (
	maxBriefActions = 3
	maxSourceRows   = 100
)

type Evidence struct {
	Kind  string `json:"kind"`
	ID    string `json:"id"`
	Key   string `json:"key"`
	Value any    `json:"value"`
}

type Target struct {
	Kind        string `json:"kind"`
	ID          string `json:"id"`
	RunID       string `json:"runId,omitempty"`
	WorkflowID  string `json:"workflowId,omitempty"`
	Destination string `json:"destination"`
}

type Action struct {
	ID             string         `json:"id"`
	Kind           string         `json:"kind"`
	Priority       int            `json:"priority"`
	Severity       string         `json:"severity"`
	TitleKey       string         `json:"titleKey"`
	BodyKey        string         `json:"bodyKey"`
	CTAKey         string         `json:"ctaKey"`
	Params         map[string]any `json:"params"`
	Evidence       []Evidence     `json:"evidence"`
	Target         Target         `json:"target"`
	AllowedActions []string       `json:"allowedActions"`
	CreatedAt      string         `json:"createdAt"`
}

type Brief struct {
	Version     string   `json:"version"`
	GeneratedAt string   `json:"generatedAt"`
	Actions     []Action `json:"actions"`
	Warnings    []string `json:"warnings"`
}

type rankedAction struct {
	action       Action
	categoryRank int
	severityRank int
	createdAt    time.Time
}

func rankActions(candidates []rankedAction) []Action {
	sort.SliceStable(candidates, func(i, j int) bool {
		left, right := candidates[i], candidates[j]
		if left.categoryRank != right.categoryRank {
			return left.categoryRank < right.categoryRank
		}
		if left.severityRank != right.severityRank {
			return left.severityRank > right.severityRank
		}
		if !left.createdAt.Equal(right.createdAt) {
			return left.createdAt.Before(right.createdAt)
		}
		return left.action.ID < right.action.ID
	})
	limit := min(maxBriefActions, len(candidates))
	actions := make([]Action, 0, limit)
	for index := range limit {
		action := candidates[index].action
		action.Priority = index + 1
		if action.Params == nil {
			action.Params = map[string]any{}
		}
		if action.Evidence == nil {
			action.Evidence = []Evidence{}
		}
		if action.AllowedActions == nil {
			action.AllowedActions = []string{}
		}
		actions = append(actions, action)
	}
	return actions
}

func recoveryCaseActions(rows []store.RecoveryCase, permissions map[string]bool, now time.Time) []rankedAction {
	actions := make([]rankedAction, 0, len(rows))
	for _, row := range rows {
		switch row.State {
		case "awaiting_approval":
			actions = append(actions, recoveryCaseAction(row, permissions, 1, "high",
				"recovery_approval", "operations.brief.recoveryApproval"))
		case "detected", "contained", "diagnosed", "candidates_ready", "validating":
			severity := "high"
			if row.Action == "quarantine" {
				severity = "critical"
			}
			actions = append(actions, recoveryCaseAction(row, permissions, 2, severity,
				"semantic_case", "operations.brief.semanticCase"))
		case "recurred":
			if row.UpdatedAt.Before(now.AddDate(0, 0, -30)) {
				continue
			}
			actions = append(actions, recoveryCaseAction(row, permissions, 4, "high",
				"recovery_regression", "operations.brief.regression"))
		}
	}
	return actions
}

func recoveryCaseAction(
	row store.RecoveryCase,
	permissions map[string]bool,
	category int,
	severity, kind, keyPrefix string,
) rankedAction {
	allowed := []string{"recovery.cases.inspect"}
	if permissions["recovery.write"] {
		switch row.State {
		case "detected", "contained":
			allowed = append(allowed, "recovery.cases.diagnose")
		case "diagnosed":
			allowed = append(allowed, "recovery.cases.candidates")
		case "candidates_ready":
			allowed = append(allowed, "recovery.cases.validate")
		case "awaiting_approval":
			allowed = append(allowed, "recovery.cases.approve", "recovery.cases.apply")
		}
	}
	workflowID := ""
	if row.WorkflowID.Valid {
		workflowID = row.WorkflowID.String
	}
	return rankedAction{
		categoryRank: category, severityRank: severityScore(severity), createdAt: row.CreatedAt,
		action: Action{
			ID: "recovery-case:" + row.ID, Kind: kind, Severity: severity,
			TitleKey: keyPrefix + ".title", BodyKey: keyPrefix + ".body", CTAKey: keyPrefix + ".cta",
			Params: map[string]any{"state": row.State, "action": row.Action},
			Evidence: []Evidence{
				{Kind: "recovery_case", ID: row.ID, Key: "state", Value: row.State},
				{Kind: "semantic_detector", ID: row.DetectorID, Key: "detectorKind", Value: row.DetectorKind},
			},
			Target: Target{
				Kind: "recovery_case", ID: row.ID, RunID: row.RunID,
				WorkflowID: workflowID, Destination: "recoveryCase",
			},
			AllowedActions: allowed, CreatedAt: row.CreatedAt.UTC().Format(time.RFC3339Nano),
		},
	}
}

func severityScore(severity string) int {
	switch severity {
	case "critical":
		return 4
	case "high":
		return 3
	case "medium":
		return 2
	case "low":
		return 1
	default:
		return 0
	}
}
