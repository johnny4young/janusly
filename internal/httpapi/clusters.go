// Failure-cluster rollup — GET /dlq/clusters on both wires. Samples come
// from dead_letters AND failed run_nodes inside the window (the contract
// reads the same two surfaces); the pure aggregator in internal/signature
// dedupes and groups them. Response: {clusters, totalSamples, windowDays},
// where totalSamples counts RAW samples before dedup, like the contract.
package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
)

func (s *V1Server) clustersCore(r *http.Request, rc v1Request) opResult {
	windowDays := 30
	if raw := r.URL.Query().Get("windowDays"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			windowDays = min(90, max(1, parsed))
		}
	}
	value, err := s.failureClustersValue(r.Context(), rc.orgID, windowDays)
	if err != nil {
		return opError(http.StatusInternalServerError, "internal_error", "Internal error", nil)
	}
	return opOK(value)
}

// homeCluster decorates the pure aggregation with the REAL post-recovery
// recurrence flag: the signature recovered with terminal impact inside
// the window and re-occurred within its 7-day monitoring window.
type homeCluster struct {
	signature.FailureCluster
	RecurredAfterRecovery bool `json:"recurredAfterRecovery"`
}

// failureClustersValue is the shared clusters read-model (focused route +
// Home snapshot).
func (s *V1Server) failureClustersValue(ctx context.Context, orgID string, windowDays int) (map[string]any, error) {
	since := time.Now().UTC().AddDate(0, 0, -windowDays)
	q := store.New(s.pool)

	deadLetters, err := q.ListDeadLetterFailureSamples(ctx, store.ListDeadLetterFailureSamplesParams{
		OrgID: orgID, CreatedAt: &since,
	})
	if err != nil {
		return nil, err
	}
	failedNodes, err := q.ListFailedRunNodeSamples(ctx, store.ListFailedRunNodeSamplesParams{
		OrgID: orgID, FinishedAt: &since,
	})
	if err != nil {
		return nil, err
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

	recurredRows, err := q.QueryRecurredClusterSignatures(ctx, store.QueryRecurredClusterSignaturesParams{
		OrgID: orgID, RecoveredAt: since,
	})
	if err != nil {
		return nil, err
	}
	recurred := make(map[string]bool, len(recurredRows))
	for _, sig := range recurredRows {
		recurred[sig] = true
	}
	clusters := make([]homeCluster, 0)
	for _, cluster := range signature.ClusterFailureSamples(samples) {
		clusters = append(clusters, homeCluster{
			FailureCluster: cluster, RecurredAfterRecovery: recurred[cluster.Signature],
		})
	}
	return map[string]any{
		"clusters":     clusters,
		"totalSamples": len(samples),
		"windowDays":   windowDays,
	}, nil
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
