package httpapi

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// T-527: the typed views pin their EXACT wire key sets. A typo'd JSON tag
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
		{"run", RunView{}, "createdAt,createdBy,id,inputJson,orgId,outcomeStatus,outputJson,parentLinkKind,parentNodeId,parentNotificationAfter,parentRunId,recoveryPlaybookAppliedRecordedAt,recoveryPlaybookValidationRecordedAt,replayMode,semanticViolationCount,status,traceId,validationEvidenceLevel,workflowRolloutId,workflowRolloutVariant,workflowVersionId"},
		{"runSummary", RunSummaryView{}, "createdAt,createdBy,hasWaitingNodes,id,orgId,outcomeStatus,outputJson,parentNodeId,parentRunId,replayMode,semanticViolationCount,status,traceId,validationEvidenceLevel,workflowId,workflowName,workflowVersionId"},
		{"dlqSummary", DeadLetterSummaryView{}, "attempt,createdAt,errorJson,id,nodeId,nodeType,orgId,recovery,replayedAt,runId,status,workflowName"},
		{"dlqDetail", DeadLetterDetailView{}, "attempt,createdAt,drill,drillOutcome,errorJson,id,nodeId,nodeJson,orgId,replayClaimedAt,replayedAt,runId,status,suspectVersion,workflowJson"},
		{"recoveryOverlay", RecoveryOverlayView{}, "comments,id,lastOccurredAt,metadataWorkflowId,occurrenceCount,owner,resolutionReason,severity,slaTargetAt,status,workflowId"},
		{"workflowListItem", WorkflowListItemView{}, "bufferedTriggerCount,createdAt,createdBy,deletedAt,folder,id,lastRunStatus,name,orgId,pausedReason,runCount,status,tags"},
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
		RunView{}, RunSummaryView{}, DeadLetterSummaryView{}, DeadLetterDetailView{},
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
