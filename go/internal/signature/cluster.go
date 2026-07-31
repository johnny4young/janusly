// Pure failure-sample aggregator, ported from the reference
// (packages/engine/src/cluster-failures.ts): dedupe by (runId, nodeId)
// preferring the DLQ-source sample, group by normalized signature, order
// clusters by frequency descending then signature ascending.
package signature

import (
	"sort"
	"time"
)

// FailureSample is one row read from dead_letters or a failed run_nodes row.
type FailureSample struct {
	Source       string // "dead_letter" | "failed_run_node"
	ID           string
	WorkflowID   string
	WorkflowName string
	RunID        string
	NodeID       string
	NodeType     string
	ToolName     string
	ErrorJSON    []byte
	CreatedAt    time.Time
}

// ClusterWorkflow counts one workflow's contribution to a cluster.
type ClusterWorkflow struct {
	WorkflowID   string `json:"workflowId"`
	WorkflowName string `json:"workflowName"`
	Count        int    `json:"count"`
}

// ClusterSampleRef is one representative drill-down reference.
type ClusterSampleRef struct {
	Source string `json:"source"`
	ID     string `json:"id"`
	RunID  string `json:"runId"`
}

// FailureCluster is the aggregated row exposed to the API.
type FailureCluster struct {
	Signature         string             `json:"signature"`
	Category          string             `json:"category"`
	Frequency         int                `json:"frequency"`
	AffectedWorkflows []ClusterWorkflow  `json:"affectedWorkflows"`
	FirstSeen         string             `json:"firstSeen"`
	LastSeen          string             `json:"lastSeen"`
	SuggestedOwner    string             `json:"suggestedOwner"`
	Samples           []ClusterSampleRef `json:"samples"`
	// RecurredAfterRecovery is part of the reference's wire shape; the
	// pilot has no recovery-impact substrate yet, so it is always false.
	RecurredAfterRecovery bool `json:"recurredAfterRecovery"`
}

const clusterSampleLimit = 5

// ClusterFailureSamples groups raw samples by normalized signature.
func ClusterFailureSamples(samples []FailureSample) []FailureCluster {
	// Dedupe by (runId, nodeId), preferring the dead_letter source so a
	// failed run that landed in DLQ doesn't count twice. First occurrence
	// order is preserved for deterministic sample refs.
	type slot struct {
		sample FailureSample
		order  int
	}
	deduped := map[string]slot{}
	orderCounter := 0
	for _, sample := range samples {
		key := sample.RunID + ":" + sample.NodeID
		existing, ok := deduped[key]
		if !ok {
			deduped[key] = slot{sample: sample, order: orderCounter}
			orderCounter++
			continue
		}
		if existing.sample.Source != "dead_letter" && sample.Source == "dead_letter" {
			deduped[key] = slot{sample: sample, order: existing.order}
		}
	}
	ordered := make([]FailureSample, 0, len(deduped))
	{
		slots := make([]slot, 0, len(deduped))
		for _, entry := range deduped {
			slots = append(slots, entry)
		}
		sort.Slice(slots, func(i, j int) bool { return slots[i].order < slots[j].order })
		for _, entry := range slots {
			ordered = append(ordered, entry.sample)
		}
	}

	type accumulator struct {
		cluster   FailureCluster
		workflows map[string]*ClusterWorkflow
		first     time.Time
		last      time.Time
	}
	clusters := map[string]*accumulator{}
	var signatureOrder []string

	for _, sample := range ordered {
		result := NormalizeJSON(sample.ErrorJSON, Context{
			NodeType: sample.NodeType, NodeID: sample.NodeID, ToolName: sample.ToolName,
		})
		acc, ok := clusters[result.Signature]
		if !ok {
			acc = &accumulator{
				cluster: FailureCluster{
					Signature: result.Signature, Category: result.Category,
					SuggestedOwner: result.SuggestedOwner,
					Samples:        []ClusterSampleRef{},
				},
				workflows: map[string]*ClusterWorkflow{},
				first:     sample.CreatedAt, last: sample.CreatedAt,
			}
			clusters[result.Signature] = acc
			signatureOrder = append(signatureOrder, result.Signature)
		}
		acc.cluster.Frequency++
		if sample.CreatedAt.Before(acc.first) {
			acc.first = sample.CreatedAt
		}
		if sample.CreatedAt.After(acc.last) {
			acc.last = sample.CreatedAt
		}
		if workflow, ok := acc.workflows[sample.WorkflowID]; ok {
			workflow.Count++
		} else {
			acc.workflows[sample.WorkflowID] = &ClusterWorkflow{
				WorkflowID: sample.WorkflowID,
				// Workflow names are operator-supplied free text — scrub.
				WorkflowName: ScrubSecretShapes(sample.WorkflowName),
				Count:        1,
			}
		}
		if len(acc.cluster.Samples) < clusterSampleLimit {
			acc.cluster.Samples = append(acc.cluster.Samples, ClusterSampleRef{
				Source: sample.Source, ID: sample.ID, RunID: sample.RunID,
			})
		}
	}

	out := make([]FailureCluster, 0, len(clusters))
	for _, sig := range signatureOrder {
		acc := clusters[sig]
		workflows := make([]ClusterWorkflow, 0, len(acc.workflows))
		for _, workflow := range acc.workflows {
			workflows = append(workflows, *workflow)
		}
		sort.SliceStable(workflows, func(i, j int) bool { return workflows[i].Count > workflows[j].Count })
		acc.cluster.AffectedWorkflows = workflows
		acc.cluster.FirstSeen = acc.first.UTC().Format("2006-01-02T15:04:05.000Z")
		acc.cluster.LastSeen = acc.last.UTC().Format("2006-01-02T15:04:05.000Z")
		out = append(out, acc.cluster)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Frequency != out[j].Frequency {
			return out[i].Frequency > out[j].Frequency
		}
		return out[i].Signature < out[j].Signature
	})
	return out
}
