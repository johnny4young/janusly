package operations

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/johnny4young/janusly/internal/signature"
	"github.com/johnny4young/janusly/internal/store"
)

type pendingApproval struct {
	RunID, NodeID, WorkflowID string
	CreatedAt                 time.Time
}

func (b Builder) pendingApprovals(ctx context.Context, orgID string) ([]pendingApproval, error) {
	rows, err := b.Pool.Query(ctx, `
		SELECT r.id, rn.node_id, coalesce(wv.workflow_id, r.workflow_version_id)::text,
		       coalesce(rn.started_at, r.created_at, now())
		FROM runs r
		JOIN run_nodes rn ON rn.run_id = r.id
		LEFT JOIN workflow_versions wv ON wv.id = r.workflow_version_id AND wv.org_id = r.org_id
		WHERE r.org_id = $1 AND r.replay_mode IS NULL
		  AND r.status = 'waiting' AND rn.status = 'waiting'
		  AND EXISTS (
		    SELECT 1
		    FROM jsonb_array_elements(coalesce(r.input_json->'workflow'->'nodes', '[]'::jsonb)) AS node
		    WHERE node->>'id' = rn.node_id
		      AND node->>'type' IN ('approval', 'human_form')
		  )
		ORDER BY coalesce(rn.started_at, r.created_at, now()) ASC, r.id ASC, rn.node_id ASC
		LIMIT 20`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []pendingApproval{}
	for rows.Next() {
		var item pendingApproval
		if err := rows.Scan(&item.RunID, &item.NodeID, &item.WorkflowID, &item.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func runApprovalAction(row pendingApproval, permissions map[string]bool) rankedAction {
	allowed := []string{"runs.inspect"}
	if permissions["runs.start"] {
		allowed = append(allowed, "runs.approve")
	}
	return rankedAction{
		categoryRank: 1, severityRank: severityScore("high"), createdAt: row.CreatedAt,
		action: Action{
			ID:   "run-approval:" + row.RunID + ":" + row.NodeID,
			Kind: "run_approval", Severity: "high",
			TitleKey: "operations.brief.runApproval.title",
			BodyKey:  "operations.brief.runApproval.body",
			CTAKey:   "operations.brief.runApproval.cta",
			Params:   map[string]any{},
			Evidence: []Evidence{{Kind: "run_node", ID: row.RunID + ":" + row.NodeID, Key: "status", Value: "waiting"}},
			Target: Target{
				Kind: "run_node", ID: row.NodeID, RunID: row.RunID,
				WorkflowID: row.WorkflowID, Destination: "runs",
			},
			AllowedActions: allowed, CreatedAt: row.CreatedAt.UTC().Format(time.RFC3339Nano),
		},
	}
}

func (b Builder) failureClusters(
	ctx context.Context,
	orgID string,
	now time.Time,
	includeDeadLetters bool,
	includeFailedNodes bool,
	includeRecurrence bool,
) ([]signature.FailureCluster, []string) {
	if !includeDeadLetters && !includeFailedNodes {
		return nil, nil
	}
	q := store.New(b.Pool)
	since := now.AddDate(0, 0, -30)
	var deadLetters []store.ListDeadLetterFailureSamplesRow
	if includeDeadLetters {
		var err error
		deadLetters, err = q.ListDeadLetterFailureSamples(ctx, store.ListDeadLetterFailureSamplesParams{
			OrgID: orgID, CreatedAt: &since,
		})
		if err != nil {
			return nil, []string{"failure_clusters_unavailable"}
		}
	}
	var failedNodes []store.ListFailedRunNodeSamplesRow
	if includeFailedNodes {
		var err error
		failedNodes, err = q.ListFailedRunNodeSamples(ctx, store.ListFailedRunNodeSamplesParams{
			OrgID: orgID, FinishedAt: &since,
		})
		if err != nil {
			return nil, []string{"failure_clusters_unavailable"}
		}
	}
	recurred := map[string]bool{}
	if includeRecurrence {
		recurredRows, err := q.QueryRecurredClusterSignatures(ctx, store.QueryRecurredClusterSignaturesParams{
			OrgID: orgID, RecoveredAt: since,
		})
		if err != nil {
			return nil, []string{"failure_recurrence_unavailable"}
		}
		for _, value := range recurredRows {
			recurred[value] = true
		}
	}
	samples := make([]signature.FailureSample, 0, len(deadLetters)+len(failedNodes))
	for _, row := range deadLetters {
		sample := signature.FailureSample{
			Source: "dead_letter", ID: row.ID, RunID: row.RunID,
			NodeID: row.NodeID, ErrorJSON: row.ErrorJson,
		}
		if row.CreatedAt != nil {
			sample.CreatedAt = *row.CreatedAt
		}
		enrichSample(&sample, row.InputJson)
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
		enrichSample(&sample, row.InputJson)
		samples = append(samples, sample)
	}
	clusters := signature.ClusterFailureSamples(samples)
	for index := range clusters {
		clusters[index].RecurredAfterRecovery = recurred[clusters[index].Signature]
	}
	return clusters, nil
}

func enrichSample(sample *signature.FailureSample, inputJSON []byte) {
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
	if json.Unmarshal(inputJSON, &input) != nil {
		return
	}
	sample.WorkflowID, sample.WorkflowName = input.Workflow.ID, input.Workflow.Name
	for _, node := range input.Workflow.Nodes {
		if node.ID != sample.NodeID {
			continue
		}
		sample.NodeType = node.Type
		sample.ToolName, _ = node.Config["tool"].(string)
		return
	}
}

func clusterAction(cluster signature.FailureCluster, permissions map[string]bool) rankedAction {
	severity := "medium"
	if cluster.RecurredAfterRecovery || cluster.Frequency >= 5 {
		severity = "high"
	}
	allowed := []string{"dlq.inspect"}
	if permissions["dlq.replay"] {
		allowed = append(allowed, "dlq.redrive")
	}
	firstSeen, _ := time.Parse(time.RFC3339Nano, cluster.FirstSeen)
	if firstSeen.IsZero() {
		firstSeen = time.Unix(0, 0).UTC()
	}
	// A normalized signature may still contain scrubbed fragments of a
	// provider error. The shared UI/MCP brief only needs a stable routing key,
	// so expose the bounded hash rather than the signature itself.
	clusterID := shortHash(cluster.Signature)
	target := Target{Kind: "failure_cluster", ID: clusterID, Destination: "recover"}
	if len(cluster.Samples) > 0 {
		target.RunID = cluster.Samples[0].RunID
	}
	if len(cluster.AffectedWorkflows) > 0 {
		target.WorkflowID = cluster.AffectedWorkflows[0].WorkflowID
	}
	return rankedAction{
		categoryRank: 3, severityRank: severityScore(severity), createdAt: firstSeen,
		action: Action{
			ID:   "failure-cluster:" + clusterID,
			Kind: "failure_cluster", Severity: severity,
			TitleKey: "operations.brief.failureCluster.title",
			BodyKey:  "operations.brief.failureCluster.body",
			CTAKey:   "operations.brief.failureCluster.cta",
			Params:   map[string]any{"count": cluster.Frequency, "category": cluster.Category},
			Evidence: []Evidence{{
				Kind: "failure_cluster", ID: clusterID,
				Key: "frequency", Value: cluster.Frequency,
			}},
			Target: target, AllowedActions: allowed, CreatedAt: cluster.FirstSeen,
		},
	}
}

func deadLetterAction(row store.ListDeadLetterSummariesRow, permissions map[string]bool) rankedAction {
	createdAt := time.Unix(0, 0).UTC()
	if row.CreatedAt != nil {
		createdAt = row.CreatedAt.UTC()
	}
	allowed := []string{"dlq.inspect"}
	if permissions["dlq.replay"] {
		allowed = append(allowed, "dlq.redrive")
	}
	return rankedAction{
		categoryRank: 5, severityRank: severityScore("medium"), createdAt: createdAt,
		action: Action{
			ID: "dead-letter:" + row.ID, Kind: "routine_triage", Severity: "medium",
			TitleKey: "operations.brief.routineTriage.title",
			BodyKey:  "operations.brief.routineTriage.body",
			CTAKey:   "operations.brief.routineTriage.cta",
			Params:   map[string]any{},
			Evidence: []Evidence{{Kind: "dead_letter", ID: row.ID, Key: "status", Value: row.Status}},
			Target: Target{
				Kind: "dead_letter", ID: row.ID, RunID: row.RunID, Destination: "recover",
			},
			AllowedActions: allowed, CreatedAt: createdAt.Format(time.RFC3339Nano),
		},
	}
}

func shortHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:8])
}
