// Typed wire views for the three most-consumed surfaces — runs, DLQ, and
// workflows. Structs with JSON tags replace the handler
// map[string]any literals so a typo'd key is a COMPILE error, and the
// pinned key-set tests + the dual comparator guard that the wire did not
// move a byte. Fields deliberately avoid omitempty: the contract says
// unpopulated columns surface as explicit nulls, never as missing keys.
package httpapi

import (
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/httpkit"
	"github.com/johnny4young/janusly/internal/recovery"
	"github.com/johnny4young/janusly/internal/store"
)

/* --------------------------------- runs ---------------------------------- */

// RunView is the contract's full run key set (GET /run, GET /status).
type RunView struct {
	ID                                   string          `json:"id"`
	OrgID                                string          `json:"orgId"`
	WorkflowVersionID                    string          `json:"workflowVersionId"`
	WorkflowRolloutID                    *string         `json:"workflowRolloutId"`
	WorkflowRolloutVariant               *string         `json:"workflowRolloutVariant"`
	Status                               string          `json:"status"`
	OutcomeStatus                        *string         `json:"outcomeStatus"`
	SemanticViolationCount               int32           `json:"semanticViolationCount"`
	InputJSON                            json.RawMessage `json:"inputJson"`
	OutputJSON                           json.RawMessage `json:"outputJson"`
	ParentRunID                          *string         `json:"parentRunId"`
	ParentNodeID                         *string         `json:"parentNodeId"`
	ParentLinkKind                       *string         `json:"parentLinkKind"`
	ParentNotificationAfter              *string         `json:"parentNotificationAfter"`
	RecoveryPlaybookAppliedRecordedAt    *string         `json:"recoveryPlaybookAppliedRecordedAt"`
	RecoveryPlaybookValidationRecordedAt *string         `json:"recoveryPlaybookValidationRecordedAt"`
	ReplayMode                           *string         `json:"replayMode"`
	TraceID                              *string         `json:"traceId"`
	ValidationEvidenceLevel              *string         `json:"validationEvidenceLevel"`
	CreatedBy                            *string         `json:"createdBy"`
	CreatedAt                            *string         `json:"createdAt"`
}

func newRunView(run store.GetRunRow) RunView {
	return RunView{
		ID: run.ID, OrgID: run.OrgID,
		WorkflowVersionID: run.WorkflowVersionID,
		Status:            run.Status, OutcomeStatus: nullableTextValue(run.OutcomeStatus),
		SemanticViolationCount: run.SemanticViolationCount,
		InputJSON:              normalizedRaw(run.InputJson), OutputJSON: normalizedRaw(run.OutputJson),
		ParentRunID: nullableTextValue(run.ParentRunID), ParentNodeID: nullableTextValue(run.ParentNodeID),
		ReplayMode: nullableTextValue(run.ReplayMode), TraceID: nullableTextValue(run.TraceID),
		ValidationEvidenceLevel: nullableTextValue(run.ValidationEvidenceLevel),
		CreatedBy:               nullableTextValue(run.CreatedBy), CreatedAt: nullableTimeValue(run.CreatedAt),
	}
}

// RunSummaryView is one GET /runs list row.
type RunSummaryView struct {
	ID                      string          `json:"id"`
	OrgID                   string          `json:"orgId"`
	WorkflowID              string          `json:"workflowId"`
	WorkflowName            any             `json:"workflowName"`
	WorkflowVersionID       string          `json:"workflowVersionId"`
	Status                  string          `json:"status"`
	HasWaitingNodes         bool            `json:"hasWaitingNodes"`
	OutcomeStatus           any             `json:"outcomeStatus"`
	SemanticViolationCount  int             `json:"semanticViolationCount"`
	OutputJSON              json.RawMessage `json:"outputJson"`
	ParentRunID             any             `json:"parentRunId"`
	ParentNodeID            any             `json:"parentNodeId"`
	ReplayMode              any             `json:"replayMode"`
	TraceID                 any             `json:"traceId"`
	ValidationEvidenceLevel any             `json:"validationEvidenceLevel"`
	CreatedBy               any             `json:"createdBy"`
	CreatedAt               any             `json:"createdAt"`
}

func newRunSummaryView(row store.ListRunSummariesRow) RunSummaryView {
	return RunSummaryView{
		ID: row.ID, OrgID: row.OrgID,
		WorkflowID: row.WorkflowID, WorkflowName: textOrNullString(row.WorkflowName),
		WorkflowVersionID: row.WorkflowVersionID, Status: row.Status,
		HasWaitingNodes:        row.HasWaitingNodes,
		OutcomeStatus:          textOrNull(row.OutcomeStatus),
		SemanticViolationCount: int(row.SemanticViolationCount),
		OutputJSON:             normalizedRaw(row.OutputJson),
		ParentRunID:            textOrNull(row.ParentRunID), ParentNodeID: textOrNull(row.ParentNodeID),
		ReplayMode: textOrNull(row.ReplayMode), TraceID: textOrNull(row.TraceID),
		ValidationEvidenceLevel: textOrNull(row.ValidationEvidenceLevel),
		CreatedBy:               textOrNull(row.CreatedBy), CreatedAt: timeOrNull(row.CreatedAt),
	}
}

/* ---------------------------------- dlq ----------------------------------- */

// RecoveryOverlayView is the ownership incident riding a DLQ list row.
type RecoveryOverlayView struct {
	ID                 string          `json:"id"`
	Owner              *string         `json:"owner"`
	Severity           string          `json:"severity"`
	Status             string          `json:"status"`
	SlaTargetAt        *string         `json:"slaTargetAt"`
	ResolutionReason   *string         `json:"resolutionReason"`
	Comments           json.RawMessage `json:"comments"`
	WorkflowID         *string         `json:"workflowId"`
	MetadataWorkflowID *string         `json:"metadataWorkflowId"`
	OccurrenceCount    int32           `json:"occurrenceCount"`
	LastOccurredAt     *string         `json:"lastOccurredAt"`
}

// DeadLetterSummaryView is one GET /v1/dlq list row.
type DeadLetterSummaryView struct {
	ID           string               `json:"id"`
	OrgID        string               `json:"orgId"`
	RunID        string               `json:"runId"`
	NodeID       string               `json:"nodeId"`
	Attempt      int32                `json:"attempt"`
	ErrorJSON    json.RawMessage      `json:"errorJson"`
	Status       string               `json:"status"`
	ReplayedAt   *string              `json:"replayedAt"`
	CreatedAt    *string              `json:"createdAt"`
	NodeType     *string              `json:"nodeType"`
	WorkflowName *string              `json:"workflowName"`
	Recovery     *RecoveryOverlayView `json:"recovery"`
}

func newDeadLetterSummaryView(row store.ListDeadLetterSummariesRow) DeadLetterSummaryView {
	var recovery *RecoveryOverlayView
	if row.RecoveryID.Valid {
		recovery = &RecoveryOverlayView{
			ID: row.RecoveryID.String, Owner: nullableTextValue(row.RecoveryOwner),
			Severity: row.RecoverySeverity, Status: row.RecoveryStatus,
			SlaTargetAt:        nullableTimeValue(row.RecoverySlaTargetAt),
			ResolutionReason:   nullableTextValue(row.RecoveryResolutionReason),
			Comments:           normalizedRaw(row.RecoveryComments),
			WorkflowID:         nullableTextValue(row.RecoveryWorkflowID),
			MetadataWorkflowID: nullableTextValue(row.RecoveryMetadataWorkflowID),
			OccurrenceCount:    row.RecoveryOccurrenceCount,
			LastOccurredAt:     nullableTimeValue(row.RecoveryLastOccurredAt),
		}
	}
	return DeadLetterSummaryView{
		ID: row.ID, OrgID: row.OrgID, RunID: row.RunID, NodeID: row.NodeID,
		Attempt: row.Attempt, ErrorJSON: normalizedRaw(row.ErrorJson), Status: row.Status,
		ReplayedAt: nullableTimeValue(row.ReplayedAt), CreatedAt: nullableTimeValue(row.CreatedAt),
		NodeType: textOrNullString(row.NodeType), WorkflowName: textOrNullString(row.WorkflowName),
		Recovery: recovery,
	}
}

// DeadLetterDetailView is the legacy GET /dlq?id= exact-snapshot detail.
type DeadLetterDetailView struct {
	ID              string                   `json:"id"`
	OrgID           string                   `json:"orgId"`
	RunID           string                   `json:"runId"`
	NodeID          string                   `json:"nodeId"`
	Attempt         int32                    `json:"attempt"`
	WorkflowJSON    json.RawMessage          `json:"workflowJson"`
	NodeJSON        json.RawMessage          `json:"nodeJson"`
	ErrorJSON       json.RawMessage          `json:"errorJson"`
	Status          string                   `json:"status"`
	ReplayedAt      *string                  `json:"replayedAt"`
	CreatedAt       *string                  `json:"createdAt"`
	ReplayClaimedAt *string                  `json:"replayClaimedAt"`
	SuspectVersion  json.RawMessage          `json:"suspectVersion"`
	Drill           *recoveryDrillProvenance `json:"drill"`
	DrillOutcome    *recovery.DrillOutcome   `json:"drillOutcome"`
}

type recoveryDrillProvenance struct {
	Kind         string `json:"kind"`
	PackID       string `json:"packId"`
	FixtureID    string `json:"fixtureId"`
	RecoveryPath string `json:"recoveryPath"`
}

func parseRecoveryDrillProvenance(inputJSON json.RawMessage) *recoveryDrillProvenance {
	var envelope struct {
		Drill map[string]any `json:"drill"`
	}
	if json.Unmarshal(inputJSON, &envelope) != nil || envelope.Drill == nil {
		return nil
	}
	text := func(key string) string {
		value, _ := envelope.Drill[key].(string)
		if value == "" || len(value) > 128 {
			return ""
		}
		return value
	}
	kind := text("kind")
	packID := text("packId")
	fixtureID := text("fixtureId")
	recoveryPath := text("recoveryPath")
	if kind != "solution_pack_drill" || packID == "" || fixtureID == "" ||
		(recoveryPath != "direct_failure" &&
			recoveryPath != "runtime_failure" &&
			recoveryPath != "stalled_node_reaper") {
		return nil
	}
	return &recoveryDrillProvenance{
		Kind: kind, PackID: packID, FixtureID: fixtureID, RecoveryPath: recoveryPath,
	}
}

func newDeadLetterDetailView(row store.GetDeadLetterRow) DeadLetterDetailView {
	return DeadLetterDetailView{
		ID: row.ID, OrgID: row.OrgID, RunID: row.RunID, NodeID: row.NodeID,
		Attempt: row.Attempt, WorkflowJSON: normalizedRaw(row.WorkflowJson),
		NodeJSON: normalizedRaw(row.NodeJson), ErrorJSON: normalizedRaw(row.ErrorJson),
		Status: row.Status, ReplayedAt: nullableTimeValue(row.ReplayedAt),
		CreatedAt: nullableTimeValue(row.CreatedAt), ReplayClaimedAt: nullableTimeValue(row.ReplayClaimedAt),
	}
}

/* ------------------------------- workflows -------------------------------- */

// WorkflowListItemView is one GET /v1/workflows list row.
type WorkflowListItemView struct {
	ID                   string   `json:"id"`
	OrgID                string   `json:"orgId"`
	Name                 string   `json:"name"`
	CreatedBy            any      `json:"createdBy"`
	CreatedAt            any      `json:"createdAt"`
	LastRunStatus        any      `json:"lastRunStatus"`
	RunCount             any      `json:"runCount"`
	BufferedTriggerCount int      `json:"bufferedTriggerCount"`
	Status               string   `json:"status"`
	PausedReason         any      `json:"pausedReason"`
	Tags                 []string `json:"tags"`
	Folder               any      `json:"folder"`
	DeletedAt            any      `json:"deletedAt"`
}

func newWorkflowListItemView(row store.ListWorkflowRowsRow) WorkflowListItemView {
	return WorkflowListItemView{
		ID: row.ID, OrgID: row.OrgID, Name: row.Name,
		CreatedBy: textOrNull(row.CreatedBy), CreatedAt: timeOrNull(row.CreatedAt),
		LastRunStatus: textOrNullString(row.LastRunStatus), RunCount: row.RunCount,
		BufferedTriggerCount: int(row.BufferedTriggerCount),
		Status:               row.Status, PausedReason: textOrNull(row.PausedReason),
		Tags: decodeStringArray(row.Tags), Folder: textOrNull(row.Folder),
		DeletedAt: timeOrNull(row.DeletedAt),
	}
}

func decodeStringArray(raw json.RawMessage) []string {
	values := make([]string, 0)
	if len(raw) == 0 || json.Unmarshal(raw, &values) != nil {
		return []string{}
	}
	return values
}

// VersionView is the contract's WorkflowVersion key set.
type VersionView struct {
	ID                    string          `json:"id"`
	OrgID                 string          `json:"orgId"`
	WorkflowID            string          `json:"workflowId"`
	Version               int32           `json:"version"`
	DagJSON               json.RawMessage `json:"dagJson"`
	SloJSON               any             `json:"sloJson"`
	UpstreamHealthSources any             `json:"upstreamHealthSources"`
	CreatedBy             any             `json:"createdBy"`
	CreatedAt             any             `json:"createdAt"`
}

func newVersionView(id, orgID, workflowID string, version int32, dagJSON json.RawMessage, createdBy pgtype.Text, createdAt *time.Time) VersionView {
	return VersionView{
		ID: id, OrgID: orgID, WorkflowID: workflowID, Version: version,
		DagJSON:   normalizedRaw(dagJSON),
		CreatedBy: textOrNull(createdBy), CreatedAt: timeOrNull(createdAt),
	}
}

func normalizedRaw(raw json.RawMessage) json.RawMessage { return httpkit.NormalizedRaw(raw) }
