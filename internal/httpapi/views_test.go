package httpapi

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/store"
)

// The typed views pin their EXACT wire key sets. A typo'd JSON tag
// breaks this test; a typo'd field name no longer compiles at all.

func viewKeys(t *testing.T, view any) []string {
	t.Helper()
	raw, err := json.Marshal(view)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	keys := make([]string, 0, len(decoded))
	for key := range decoded {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func TestViewKeySetsPinned(t *testing.T) {
	cases := []struct {
		name string
		view any
		want string
	}{
		{"runSnapshot", RunSnapshotView{}, "events,eventsCursor,eventsHasMore,nodes,run"},
		{"runNode", RunNodeView{}, "attempts,errorJson,finishedAt,id,nodeId,runId,startedAt,stateJson,status"},
		{"runEvent", RunEventView{}, "createdAt,holdUntil,id,nodeId,payload,runId,type"},
		{"run", RunView{}, "createdAt,createdBy,id,inputJson,orgId,outcomeStatus,outputJson,parentLinkKind,parentNodeId,parentNotificationAfter,parentRunId,recoveryPlaybookAppliedRecordedAt,recoveryPlaybookValidationRecordedAt,replayMode,semanticViolationCount,status,traceId,validationEvidenceLevel,workflowRolloutId,workflowRolloutVariant,workflowVersionId"},
		{"runSummary", RunSummaryView{}, "createdAt,createdBy,cursor,hasWaitingNodes,id,orgId,outcomeStatus,outputJson,parentNodeId,parentRunId,replayMode,semanticViolationCount,status,traceId,validationEvidenceLevel,workflowId,workflowName,workflowVersionId"},
		{"dlqSummary", DeadLetterSummaryView{}, "attempt,createdAt,errorJson,id,nodeId,nodeType,orgId,recovery,replayedAt,runId,status,workflowName"},
		{"dlqDetail", DeadLetterDetailView{}, "attempt,createdAt,drill,drillOutcome,errorJson,id,nodeId,nodeJson,orgId,replayClaimedAt,replayedAt,runId,status,suspectVersion,workflowJson"},
		{"recoveryOverlay", RecoveryOverlayView{}, "comments,id,lastOccurredAt,metadataWorkflowId,occurrenceCount,owner,resolutionReason,severity,slaTargetAt,status,workflowId"},
		{"workflowListItem", WorkflowListItemView{}, "bufferedTriggerCount,createdAt,createdBy,currentVersion,deletedAt,folder,id,lastRunAt,lastRunStatus,name,openFailureCount,orgId,pausedReason,productionVersion,rollout,runCount,status,tags"},
		{"version", VersionView{}, "createdAt,createdBy,dagJson,id,orgId,sloJson,upstreamHealthSources,version,workflowId"},
	}
	for _, tc := range cases {
		got := strings.Join(viewKeys(t, tc.view), ",")
		if got != tc.want {
			t.Fatalf("%s key set drifted:\n got %s\nwant %s", tc.name, got, tc.want)
		}
	}
}

// Every view field must carry an explicit json tag (no accidental
// Go-cased keys), and none may use omitempty (the contract demands
// explicit nulls, never missing keys).
func TestViewTagsExplicitAndNeverOmitEmpty(t *testing.T) {
	for _, view := range []any{
		RunSnapshotView{}, RunNodeView{}, RunEventView{}, RunView{}, RunSummaryView{}, DeadLetterSummaryView{}, DeadLetterDetailView{},
		RecoveryOverlayView{}, WorkflowListItemView{}, VersionView{},
	} {
		viewType := reflect.TypeOf(view)
		for field := range viewType.Fields() {
			tag := field.Tag.Get("json")
			if tag == "" {
				t.Fatalf("%s.%s has no json tag", viewType.Name(), field.Name)
			}
			if strings.Contains(tag, "omitempty") {
				t.Fatalf("%s.%s uses omitempty — the contract demands explicit nulls", viewType.Name(), field.Name)
			}
		}
	}
}

func TestRunSummaryProjectsAssurancePosture(t *testing.T) {
	view := newRunSummaryView(store.ListRunSummariesRow{
		OutcomeStatus:           pgtype.Text{String: "semantic_recovered", Valid: true},
		SemanticViolationCount:  2,
		ValidationEvidenceLevel: pgtype.Text{String: "provider_simulated", Valid: true},
	})
	if view.OutcomeStatus == nil || *view.OutcomeStatus != "semantic_recovered" ||
		view.SemanticViolationCount != 2 ||
		view.ValidationEvidenceLevel == nil || *view.ValidationEvidenceLevel != "provider_simulated" {
		t.Fatalf("run summary dropped assurance posture: %+v", view)
	}
}

func TestRunSummaryCursorKeepsFullPrecision(t *testing.T) {
	createdAt := time.Date(2026, 11, 6, 5, 11, 35, 986123000, time.UTC)
	view := newRunSummaryView(store.ListRunSummariesRow{ID: "run-b", CreatedAt: &createdAt})
	if view.Cursor == nil {
		t.Fatal("run summary with a timestamp has no cursor")
	}
	at, id, ok := parseEventsCursor(*view.Cursor)
	if !ok || !at.Equal(createdAt) || id != "run-b" {
		t.Fatalf("cursor %q does not resume exactly after the row: %v %q", *view.Cursor, at, id)
	}
	if *view.CreatedAt != "2026-11-06T05:11:35.986Z" {
		t.Fatalf("createdAt changed shape: %q", *view.CreatedAt)
	}
	if newRunSummaryView(store.ListRunSummariesRow{ID: "run-c"}).Cursor != nil {
		t.Fatal("a run without a timestamp cannot be a cursor")
	}
}

func TestParseRecoveryDrillProvenance(t *testing.T) {
	got := parseRecoveryDrillProvenance(json.RawMessage(`{
		"drill":{
			"kind":"solution_pack_drill",
			"packId":"incident-triage",
			"fixtureId":"worker_interrupted_during_page",
			"failureMode":"worker_stalled",
			"recoveryPath":"stalled_node_reaper",
			"thresholdMinutes":60
		}
	}`))
	if got == nil || got.PackID != "incident-triage" ||
		got.FixtureID != "worker_interrupted_during_page" ||
		got.RecoveryPath != "stalled_node_reaper" {
		t.Fatalf("valid server provenance was not projected: %+v", got)
	}
	for _, raw := range []json.RawMessage{
		json.RawMessage(`{"drill":{"kind":"operator_input","packId":"p","fixtureId":"f","recoveryPath":"runtime_failure"}}`),
		json.RawMessage(`{"drill":{"kind":"solution_pack_drill","packId":"p","fixtureId":"f","recoveryPath":"invented"}}`),
		json.RawMessage(`{"drill":{"kind":"solution_pack_drill","packId":"p","fixtureId":"","recoveryPath":"runtime_failure"}}`),
		json.RawMessage(`{"drill":{"kind":"solution_pack_drill","packId":"` + strings.Repeat("x", 129) + `","fixtureId":"f","recoveryPath":"runtime_failure"}}`),
		json.RawMessage(`{"drill":"not-an-object"}`),
	} {
		if parsed := parseRecoveryDrillProvenance(raw); parsed != nil {
			t.Fatalf("untrusted drill provenance must fail closed: %+v", parsed)
		}
	}
}

func TestWorkflowStageFollowsTheRolloutThatRoutesTraffic(t *testing.T) {
	row := func(status string, canary int32) store.ListWorkflowRowsRow {
		return store.ListWorkflowRowsRow{CurrentVersion: 3, RolloutStatus: status,
			RolloutTrafficPercent: 10, RolloutBaselineVersion: 2, RolloutCanaryVersion: canary}
	}
	cases := []struct {
		name       string
		row        store.ListWorkflowRowsRow
		production int
		rollout    bool
		share      int
	}{
		{"no rollout", row("", 0), 3, false, 0},
		{"active", row("active", 3), 2, true, 10},
		{"rolled back", row("rolled_back", 3), 2, true, 0},
		{"cancelled", row("cancelled", 3), 2, true, 0},
		{"promoted", row("promoted", 3), 3, true, 100},
		{"newer save", row("rolled_back", 2), 3, false, 0},
	}
	for _, tc := range cases {
		production, rollout := workflowStage(tc.row)
		if production != tc.production || (rollout != nil) != tc.rollout {
			t.Fatalf("%s: production v%d rollout %+v", tc.name, production, rollout)
		}
		if rollout != nil && (rollout.Status != tc.row.RolloutStatus || rollout.TrafficPercent != tc.share) {
			t.Fatalf("%s: rollout %+v, want share %d", tc.name, rollout, tc.share)
		}
	}
}
