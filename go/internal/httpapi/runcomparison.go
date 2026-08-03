// Run comparison is the shared read model used by Replay Lab and historical
// diagnosis. Both run ids are tenant-scoped before their node/usage data is
// read; unknown and cross-org ids therefore share the same non-enumerating 404.
package httpapi

import (
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"slices"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/go/internal/auth"
	"github.com/johnny4young/janusly/go/internal/store"
)

type runComparisonRunSummary struct {
	ID          string `json:"id"`
	Status      string `json:"status"`
	ReplayMode  any    `json:"replayMode"`
	ParentRunID any    `json:"parentRunId"`
	CreatedAt   any    `json:"createdAt"`
}

type runComparisonNodeSide struct {
	Status    string          `json:"status"`
	LatencyMs *int64          `json:"latencyMs"`
	CostUSD   *float64        `json:"costUsd"`
	Tokens    int64           `json:"tokens"`
	Output    json.RawMessage `json:"output"`
	ErrorJSON json.RawMessage `json:"errorJson"`
}

type runComparisonNode struct {
	NodeID string                `json:"nodeId"`
	Base   runComparisonNodeSide `json:"base"`
	Replay runComparisonNodeSide `json:"replay"`
}

type runComparisonView struct {
	BaseRun   runComparisonRunSummary `json:"baseRun"`
	ReplayRun runComparisonRunSummary `json:"replayRun"`
	PerNode   []runComparisonNode     `json:"perNode"`
}

type runComparisonUsageKey struct {
	runID  string
	nodeID string
}

func comparisonRunSummary(run store.GetRunRow) runComparisonRunSummary {
	return runComparisonRunSummary{
		ID: run.ID, Status: run.Status,
		ReplayMode: textOrNull(run.ReplayMode), ParentRunID: textOrNull(run.ParentRunID),
		CreatedAt: timeOrNull(run.CreatedAt),
	}
}

func missingComparisonSide() runComparisonNodeSide {
	return runComparisonNodeSide{
		Status: "missing", Output: json.RawMessage("null"), ErrorJSON: json.RawMessage("null"),
	}
}

func comparisonOutput(status string, state json.RawMessage) json.RawMessage {
	if status != "succeeded" {
		return normalizedRaw(state)
	}
	var projected struct {
		Output json.RawMessage `json:"output"`
	}
	if json.Unmarshal(state, &projected) != nil || len(projected.Output) == 0 {
		return json.RawMessage("null")
	}
	return projected.Output
}

func comparisonNodeSide(
	node *store.ListRunNodesByRunRow,
	usage store.ListRunComparisonUsageRow,
	hasUsage bool,
) runComparisonNodeSide {
	if node == nil {
		return missingComparisonSide()
	}
	var latency *int64
	if node.StartedAt != nil && node.FinishedAt != nil {
		value := max(node.FinishedAt.Sub(*node.StartedAt).Milliseconds(), 0)
		latency = &value
	}
	var cost *float64
	if hasUsage && usage.HasCost {
		value := usage.CostUsd
		cost = &value
	}
	tokens := int64(0)
	if hasUsage {
		tokens = usage.Tokens
	}
	return runComparisonNodeSide{
		Status: node.Status, LatencyMs: latency, CostUSD: cost, Tokens: tokens,
		Output: comparisonOutput(node.Status, node.StateJson), ErrorJSON: normalizedRaw(node.ErrorJson),
	}
}

func comparisonRunNotFound(err error, which string) *opResult {
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	message := "Replay run not found"
	if which == "base" {
		message = "Base run not found"
	}
	result := opError(http.StatusNotFound, "runs_compare_run_not_found", message, nil)
	return &result
}

func (s *V1Server) runComparisonCore(r *http.Request, rc v1Request) opResult {
	query := r.URL.Query()
	baseRunID, replayRunID := query.Get("baseRunId"), query.Get("replayRunId")
	if baseRunID == "" || replayRunID == "" {
		return opError(http.StatusBadRequest, "runs_base_and_replay_run_id_required",
			"baseRunId and replayRunId are required", nil)
	}

	ctx := r.Context()
	q := store.New(s.pool)
	baseRun, err := q.GetRun(ctx, store.GetRunParams{ID: baseRunID, OrgID: rc.orgID})
	if missing := comparisonRunNotFound(err, "base"); missing != nil {
		return *missing
	} else if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	replayRun, err := q.GetRun(ctx, store.GetRunParams{ID: replayRunID, OrgID: rc.orgID})
	if missing := comparisonRunNotFound(err, "replay"); missing != nil {
		return *missing
	} else if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}

	baseRows, err := q.ListRunNodesByRun(ctx, baseRunID)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	replayRows, err := q.ListRunNodesByRun(ctx, replayRunID)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	usageRows, err := q.ListRunComparisonUsage(ctx, store.ListRunComparisonUsageParams{
		OrgID: rc.orgID, RunIds: []string{baseRunID, replayRunID},
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}

	baseByNode := make(map[string]store.ListRunNodesByRunRow, len(baseRows))
	replayByNode := make(map[string]store.ListRunNodesByRunRow, len(replayRows))
	nodeIDs := make(map[string]struct{}, len(baseRows)+len(replayRows))
	for _, row := range baseRows {
		baseByNode[row.NodeID] = row
		nodeIDs[row.NodeID] = struct{}{}
	}
	for _, row := range replayRows {
		replayByNode[row.NodeID] = row
		nodeIDs[row.NodeID] = struct{}{}
	}
	usageByNode := make(map[runComparisonUsageKey]store.ListRunComparisonUsageRow, len(usageRows))
	for _, row := range usageRows {
		usageByNode[runComparisonUsageKey{runID: row.RunID, nodeID: row.NodeID}] = row
	}

	orderedNodeIDs := slices.Sorted(maps.Keys(nodeIDs))
	perNode := make([]runComparisonNode, 0, len(orderedNodeIDs))
	for _, nodeID := range orderedNodeIDs {
		baseNode, hasBase := baseByNode[nodeID]
		replayNode, hasReplay := replayByNode[nodeID]
		baseUsage, hasBaseUsage := usageByNode[runComparisonUsageKey{runID: baseRunID, nodeID: nodeID}]
		replayUsage, hasReplayUsage := usageByNode[runComparisonUsageKey{runID: replayRunID, nodeID: nodeID}]
		var baseNodePointer, replayNodePointer *store.ListRunNodesByRunRow
		if hasBase {
			baseNodePointer = &baseNode
		}
		if hasReplay {
			replayNodePointer = &replayNode
		}
		perNode = append(perNode, runComparisonNode{
			NodeID: nodeID,
			Base:   comparisonNodeSide(baseNodePointer, baseUsage, hasBaseUsage),
			Replay: comparisonNodeSide(replayNodePointer, replayUsage, hasReplayUsage),
		})
	}

	return opOK(runComparisonView{
		BaseRun: comparisonRunSummary(baseRun), ReplayRun: comparisonRunSummary(replayRun), PerNode: perNode,
	})
}

func (s *V1Server) mountRunComparisonRoutes(mux *http.ServeMux) {
	s.route(mux, "GET /runs/compare", routeGate{auth.RoleViewer, "runs.read"}, func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		writeLegacy(w, s.runComparisonCore(r, rc))
	})
}
