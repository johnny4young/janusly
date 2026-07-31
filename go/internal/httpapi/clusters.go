// Failure-cluster rollup — GET /dlq/clusters on both wires. Samples come
// from dead_letters AND failed run_nodes inside the window (the reference
// reads the same two surfaces); the pure aggregator in internal/signature
// dedupes and groups them. Response: {clusters, totalSamples, windowDays},
// where totalSamples counts RAW samples before dedup, like the reference.
package httpapi

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/johnny4young/janusly/go/internal/signature"
	"github.com/johnny4young/janusly/go/internal/store"
)

func (s *V1Server) clustersCore(r *http.Request, rc v1Request) opResult {
	windowDays := 30
	if raw := r.URL.Query().Get("windowDays"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			windowDays = min(90, max(1, parsed))
		}
	}
	since := time.Now().UTC().AddDate(0, 0, -windowDays)
	ctx := r.Context()
	q := store.New(s.pool)

	deadLetters, err := q.ListDeadLetterFailureSamples(ctx, store.ListDeadLetterFailureSamplesParams{
		OrgID: rc.orgID, CreatedAt: &since,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}
	failedNodes, err := q.ListFailedRunNodeSamples(ctx, store.ListFailedRunNodeSamplesParams{
		OrgID: rc.orgID, FinishedAt: &since,
	})
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error: "+err.Error(), nil)
	}

	samples := make([]signature.FailureSample, 0, len(deadLetters)+len(failedNodes))
	for _, row := range deadLetters {
		sample := signature.FailureSample{
			Source: "dead_letter", ID: row.ID, RunID: row.RunID, NodeID: row.NodeID,
			ErrorJSON: row.ErrorJson,
		}
		if row.CreatedAt != nil {
			sample.CreatedAt = *row.CreatedAt
		}
		enrichSampleFromRunInput(&sample, row.InputJson)
		samples = append(samples, sample)
	}
	for _, row := range failedNodes {
		sample := signature.FailureSample{
			Source: "failed_run_node", ID: row.RunID + ":" + row.NodeID,
			RunID: row.RunID, NodeID: row.NodeID, ErrorJSON: row.ErrorJson,
		}
		if row.FinishedAt != nil {
			sample.CreatedAt = *row.FinishedAt
		}
		enrichSampleFromRunInput(&sample, row.InputJson)
		samples = append(samples, sample)
	}

	return opOK(map[string]any{
		"clusters":     signature.ClusterFailureSamples(samples),
		"totalSamples": len(samples),
		"windowDays":   windowDays,
	})
}

// enrichSampleFromRunInput reads workflow identity + failing-node type/tool
// out of the run's persisted input_json.workflow snapshot.
func enrichSampleFromRunInput(sample *signature.FailureSample, inputJSON []byte) {
	var input struct {
		Workflow struct {
			ID    string `json:"id"`
			Name  string `json:"name"`
			Nodes []struct {
				ID     string         `json:"id"`
				Type   string         `json:"type"`
				Config map[string]any `json:"config"`
			} `json:"nodes"`
		} `json:"workflow"`
	}
	if err := json.Unmarshal(inputJSON, &input); err != nil {
		return
	}
	sample.WorkflowID = input.Workflow.ID
	sample.WorkflowName = input.Workflow.Name
	for _, node := range input.Workflow.Nodes {
		if node.ID == sample.NodeID {
			sample.NodeType = node.Type
			if tool, ok := node.Config["tool"].(string); ok {
				sample.ToolName = tool
			}
			return
		}
	}
}
