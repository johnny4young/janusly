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
	viewer := recoveryCaseActions(rows, map[string]bool{}, now)
	if len(viewer) != 2 || len(viewer[0].action.AllowedActions) != 1 {
		t.Fatalf("viewer must only inspect: %+v", viewer)
	}
	editor := recoveryCaseActions(rows, map[string]bool{"recovery.write": true}, now)
	if editor[0].action.AllowedActions[1] != "recovery.cases.approve" ||
		editor[1].action.AllowedActions[1] != "recovery.cases.diagnose" {
		t.Fatalf("state actions drifted: %+v", editor)
	}
	if editor[1].action.Severity != "critical" {
		t.Fatalf("quarantine semantic case should be critical: %+v", editor[1])
	}
}
