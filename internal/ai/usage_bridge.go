// The telemetry bridge from the chokepoint to the process-global usage
// recorder: one row per attempt, success AND fallback, fired
// fire-and-forget — the recorder's own contract already guarantees a
// telemetry failure never breaks the LLM call it measures.
package ai

import (
	"context"

	"github.com/johnny4young/janusly/internal/usage"
)

type usageRecord struct {
	provider  string
	model     string
	latencyMs int64
	simulated bool
	mode      string
	aiError   string
	usage     *Usage
	costUsd   *float64
}

func fireUsage(ctx context.Context, call CallContext, record usageRecord) {
	out := usage.Record{
		OrgID: call.OrgID, UserID: call.UserID, RunID: call.RunID,
		NodeID: call.NodeID, WorkflowID: call.WorkflowID,
		Provider: record.provider, Model: record.model,
		LatencyMs: record.latencyMs, ProviderSimulated: record.simulated,
		Mode: record.mode, AiError: record.aiError,
		CostUsd: record.costUsd,
	}
	if record.usage != nil {
		out.InputTokens = new(record.usage.InputTokens)
		out.OutputTokens = new(record.usage.OutputTokens)
		out.TotalTokens = new(record.usage.TotalTokens)
		if record.usage.CachedInputTokens > 0 {
			out.CachedInputTokens = new(record.usage.CachedInputTokens)
		}
		if record.usage.CacheCreationInputTokens > 0 {
			out.CacheCreationInputTokens = new(record.usage.CacheCreationInputTokens)
		}
	}
	usage.Fire(ctx, out)
}
