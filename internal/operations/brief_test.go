package operations

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/store"
)

func TestRankActionsIsBoundedAndDeterministic(t *testing.T) {
	base := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	candidates := []rankedAction{
		{categoryRank: 3, severityRank: 4, createdAt: base, action: Action{ID: "cluster"}},
		{categoryRank: 1, severityRank: 3, createdAt: base.Add(time.Minute), action: Action{ID: "approval-new"}},
		{categoryRank: 1, severityRank: 3, createdAt: base, action: Action{ID: "approval-old"}},
		{categoryRank: 2, severityRank: 4, createdAt: base, action: Action{ID: "semantic"}},
	}
	got := rankActions(candidates)
	if len(got) != 3 {
		t.Fatalf("expected bounded top 3, got %d", len(got))
	}
	want := []string{"approval-old", "approval-new", "semantic"}
	for index, id := range want {
		if got[index].ID != id || got[index].Priority != index+1 {
			t.Fatalf("rank %d = %+v, want %s", index, got[index], id)
		}
		if got[index].Evidence == nil || got[index].AllowedActions == nil || got[index].Params == nil {
			t.Fatalf("bounded response collections must never be null: %+v", got[index])
		}
	}
}

func TestRecoveryCaseActionsReflectStateAndPermission(t *testing.T) {
	now := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	rows := []store.RecoveryCase{
		{
			ID: "approval", RunID: "run-a", DetectorID: "detector-a",
			DetectorKind: "jsonpath", State: "awaiting_approval", Action: "quarantine",
			CreatedAt: now.Add(-time.Hour), UpdatedAt: now,
			WorkflowID: pgtype.Text{String: "workflow-a", Valid: true},
		},
		{
			ID: "diagnose", RunID: "run-b", DetectorID: "detector-b",
			DetectorKind: "jsonpath", State: "contained", Action: "quarantine",
			CreatedAt: now, UpdatedAt: now,
		},
	}
	viewer := recoveryCaseActions(rows, map[string]bool{}, now, true)
	if len(viewer) != 2 || len(viewer[0].action.AllowedActions) != 1 {
		t.Fatalf("viewer must only inspect: %+v", viewer)
	}
	editor := recoveryCaseActions(rows, map[string]bool{"recovery.write": true}, now, true)
	if editor[0].action.AllowedActions[1] != "recovery.cases.approve" ||
		editor[1].action.AllowedActions[1] != "recovery.cases.diagnose" {
		t.Fatalf("state actions drifted: %+v", editor)
	}
	if editor[1].action.Severity != "critical" {
		t.Fatalf("quarantine semantic case should be critical: %+v", editor[1])
	}
	service := recoveryCaseActions(rows, map[string]bool{"recovery.write": true}, now, false)
	if len(service) != 2 || len(service[0].action.AllowedActions) != 2 ||
		service[0].action.AllowedActions[1] != "recovery.cases.apply" {
		t.Fatalf("service actor should consume an independent grant without being offered approval: %+v", service)
	}
}

func TestMCPAllowedActionsProjectToExecutableCatalog(t *testing.T) {
	canonical := []string{
		"recovery.cases.inspect",
		"recovery.cases.candidates",
		"recovery.cases.approve",
		"recovery.cases.apply",
		"runs.inspect",
		"runs.approve",
		"dlq.inspect",
		"dlq.redrive",
		"future.unregistered.action",
		"recovery.cases.diagnose",
	}
	got := projectAllowedActions(ActionSurfaceMCP, canonical)
	want := []string{
		"recovery.cases.inspect",
		"recovery.cases.diagnose",
		"recovery.cases.apply",
		"runs.inspect",
		"dlq.list",
		"dlq.redrive",
	}
	if len(got) != len(want) {
		t.Fatalf("MCP action projection = %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("MCP action projection = %v, want %v", got, want)
		}
	}
	if unknown := projectAllowedActions(ActionSurface(255), canonical); len(unknown) != 0 {
		t.Fatalf("unknown surface must fail closed: %v", unknown)
	}
	if api := projectAllowedActions(ActionSurfaceAPI, canonical); len(api) != len(canonical) {
		t.Fatalf("API action vocabulary drifted: %v", api)
	}
}
