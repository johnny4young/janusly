package contract

// Rationale parameters interpolate display copy; keys vary by rationale code
// but values are always scalars.
var rationaleMeta = map[string]any{
	"type":                 "object",
	"additionalProperties": map[string]any{"type": []any{"string", "number", "boolean"}},
}

var healthEntry = closedObj(map[string]any{
	"score": intT(), "rationale": str(), "rationaleCode": str(), "rationaleMeta": rationaleMeta,
}, "score", "rationale", "rationaleCode")

var healthStatus = map[string]any{"type": "string", "enum": []any{"healthy", "warn", "unhealthy"}}

var workflowHealthScore = closedObj(map[string]any{
	"score":  intT(),
	"status": healthStatus,
	"breakdown": closedObj(map[string]any{
		"reliability": healthEntry, "safety": healthEntry, "latency": healthEntry,
		"cost": healthEntry, "maintainability": healthEntry, "aiRisk": healthEntry,
	}, "reliability", "safety", "latency", "cost", "maintainability", "aiRisk"),
	"signals": closedObj(map[string]any{
		"totalRuns": countT(), "successCount": countT(), "failureCount": countT(),
		"retryCount": countT(), "dlqOpenCount": countT(), "p95LatencyMs": nullableNum(),
		"totalCostUsd": num(), "totalTokens": num(), "versionCount": countT(),
	}, "totalRuns", "successCount", "failureCount", "retryCount", "dlqOpenCount",
		"p95LatencyMs", "totalCostUsd", "totalTokens", "versionCount"),
	"slo": nullable(closedObj(map[string]any{
		"slo": closedObj(map[string]any{
			"successRatePercent": nullableNum(), "p95DurationMs": nullableNum(),
			"mttrSeconds": nullableNum(), "budgetBlocksPerWindow": nullableNum(),
			"stuckWaitingNodesMax": nullableNum(),
			"windowDays":           map[string]any{"type": []any{"integer", "null"}},
		}, "successRatePercent", "p95DurationMs", "mttrSeconds", "budgetBlocksPerWindow",
			"stuckWaitingNodesMax", "windowDays"),
		"breaches": closedObj(map[string]any{
			"successRate": boolT(), "p95": boolT(), "anyBreach": boolT(),
		}, "successRate", "p95", "anyBreach"),
	}, "slo", "breaches")),
}, "score", "status", "breakdown", "signals", "slo")

var workflowHealthDelta = closedObj(map[string]any{
	"workflowId": str(), "afterVersion": intT(), "windowDays": intT(), "hasEnoughData": boolT(),
	"before": workflowHealthScore, "after": workflowHealthScore,
	"delta": nullable(closedObj(map[string]any{
		"score": intT(), "p95LatencyMs": nullableNum(), "costPerRunUsd": nullableNum(),
	}, "score", "p95LatencyMs", "costPerRunUsd")),
	"recentRunsAgainstAfter": closedObj(map[string]any{
		"totalRuns": countT(), "succeeded": countT(), "failed": countT(), "running": countT(),
	}, "totalRuns", "succeeded", "failed", "running"),
	"sameFailureSinceApply": nullable(closedObj(map[string]any{
		"count": countT(), "sampleDeadLetterIds": arr(str()), "priorSignature": str(),
	}, "count", "sampleDeadLetterIds", "priorSignature")),
	"priorVersion": nullable(closedObj(map[string]any{
		"version": intT(), "versionId": str(),
	}, "version", "versionId")),
}, "workflowId", "afterVersion", "windowDays", "hasEnoughData", "before", "after", "delta",
	"recentRunsAgainstAfter", "sameFailureSinceApply", "priorVersion")
