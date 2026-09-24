package contract

import (
	"maps"
	"slices"
)

var recoveryCase = closedObj(map[string]any{
	"id": str(), "orgId": str(), "runId": str(), "workflowId": nullableString(),
	"workflowVersionId": str(), "source": str(), "detectorId": str(),
	"sourceNodeId": str(), "detectorKind": str(), "action": str(),
	"message": str(), "detailsJson": recoveryEvidenceJSON, "state": str(),
	"revision": intT(), "createdBy": nullableString(),
	"createdAt": str(), "updatedAt": str(), "resolvedAt": nullableString(),
}, "id", "orgId", "runId", "workflowId", "workflowVersionId", "source", "detectorId",
	"sourceNodeId", "detectorKind", "action", "message", "detailsJson", "state", "revision",
	"createdBy", "createdAt", "updatedAt", "resolvedAt")

var recoveryArtifact = closedObj(map[string]any{
	"id": str(), "caseId": str(), "kind": str(), "payload": recoveryEvidenceJSON,
	"sha256": str(), "actorKind": str(), "actorId": nullableString(), "createdAt": str(),
}, "id", "caseId", "kind", "payload", "sha256", "actorKind", "actorId", "createdAt")

var recoveryTransition = closedObj(map[string]any{
	"id": str(), "orgId": str(), "caseId": str(), "fromState": str(), "toState": str(),
	"actorKind": str(), "actorId": nullableString(), "evidenceJson": recoveryEvidenceJSON,
	"reason": nullableString(), "occurredAt": str(),
}, "id", "orgId", "caseId", "fromState", "toState", "actorKind", "actorId", "evidenceJson", "reason", "occurredAt")

var recoveryAutonomy = closedObj(map[string]any{
	"level":             map[string]any{"type": []any{"integer", "null"}},
	"source":            str(),
	"detectorIds":       arr(str()),
	"unavailableReason": nullableString(),
	"capabilities": closedObj(map[string]any{
		"observe": boolT(), "recommend": boolT(), "validate": boolT(),
		"applyWithApproval": boolT(), "autonomousApply": boolT(),
	}, "observe", "recommend", "validate", "applyWithApproval", "autonomousApply"),
	"factors": arr(closedObj(map[string]any{
		"capability": str(), "requiredLevel": intT(), "enabled": boolT(),
	}, "capability", "requiredLevel", "enabled")),
}, "level", "source", "detectorIds", "unavailableReason", "capabilities", "factors")

var recoveryActiveApproval = map[string]any{
	"type": []any{"object", "null"},
	"properties": map[string]any{
		"candidateArtifactId":  str(),
		"validationArtifactId": str(),
		"caseRevision":         map[string]any{"type": "integer", "minimum": 1},
		"expiresAt":            str(),
	},
	"required":             []string{"candidateArtifactId", "validationArtifactId", "caseRevision", "expiresAt"},
	"additionalProperties": false,
}

var recoveryCaseDetail = closedObj(map[string]any{
	"case":           recoveryCase,
	"transitions":    arr(recoveryTransition),
	"artifacts":      arr(recoveryArtifact),
	"autonomy":       recoveryAutonomy,
	"activeApproval": recoveryActiveApproval,
}, "case", "transitions", "artifacts", "autonomy", "activeApproval")

var recoveryRevisionRequest = closedObj(map[string]any{
	"expectedRevision": map[string]any{"type": "integer", "minimum": 1},
}, "expectedRevision")

var recoveryCandidateBindingRequest = closedObj(map[string]any{
	"expectedRevision":    map[string]any{"type": "integer", "minimum": 1},
	"candidateArtifactId": str(),
}, "expectedRevision", "candidateArtifactId")

var recoveryApprovalBindingRequest = closedObj(map[string]any{
	"expectedRevision":     map[string]any{"type": "integer", "minimum": 1},
	"candidateArtifactId":  str(),
	"validationArtifactId": str(),
}, "expectedRevision", "candidateArtifactId", "validationArtifactId")

// Every recovery metric shares the display envelope; each one declares the
// extra fields it adds.
var metricSeverity = map[string]any{"type": "string", "enum": []any{"healthy", "warn", "unhealthy", "neutral"}}

func metricObjWith(extra map[string]any) Schema {
	properties := map[string]any{
		"value": nullableNum(), "display": str(), "severity": metricSeverity,
		"rationale": str(), "rationaleCode": str(), "rationaleMeta": rationaleMeta,
	}
	required := []string{"value", "display", "severity", "rationale", "rationaleCode"}
	for _, key := range slices.Sorted(maps.Keys(extra)) {
		properties[key] = extra[key]
		required = append(required, key)
	}
	return closedObj(properties, required...)
}

var costProviderRow = closedObj(map[string]any{
	"provider": str(), "model": str(), "usd": num(), "tokens": num(),
	"inputTokens": num(), "cachedInputTokens": num(), "cacheCreationInputTokens": num(),
	"calls": num(), "aggregated": boolT(),
}, "provider", "model", "usd", "tokens", "inputTokens", "cachedInputTokens",
	"cacheCreationInputTokens", "calls", "aggregated")

var recoveryMetrics = closedObj(map[string]any{
	"successRate": metricObjWith(nil),
	"verifiedRecovery": metricObjWith(map[string]any{
		"definitionVersion": str(), "metric": str(), "unit": str(),
		"sampleSize": countT(), "p50Ms": nullableNum(), "p90Ms": nullableNum(),
	}),
	"mttr":             metricObjWith(nil),
	"p95Latency":       metricObjWith(nil),
	"approvalsPending": metricObjWith(nil),
	"replayRate":       metricObjWith(nil),
	"costThisWindow": metricObjWith(map[string]any{
		"providers": arr(costProviderRow),
		"cache": closedObj(map[string]any{
			"inputTokens": num(), "readTokens": num(), "creationTokens": num(),
			"readSharePercent": nullableNum(),
		}, "inputTokens", "readTokens", "creationTokens", "readSharePercent"),
	}),
	"clustersResolved": metricObjWith(map[string]any{"totalEntries": countT(), "capped": boolT()}),
	"slaAttainment":    metricObjWith(map[string]any{"resolvedInWindow": countT(), "metSla": countT()}),
	"timeToFirstAction": metricObjWith(map[string]any{
		"unit": str(), "sampleSize": countT(), "avgSeconds": nullableNum(), "p95Seconds": nullableNum(),
	}),
	"recurrenceRate": metricObjWith(nil),
	"valueEstimate": closedObj(map[string]any{
		"hoursSaved": num(), "dollarSaved": num(), "mttrDeltaSeconds": nullableNum(),
		"assumptions": closedObj(map[string]any{
			"hourlyCost": num(), "minutesSavedPerRecovery": num(), "baselineMttrSeconds": num(),
		}, "hourlyCost", "minutesSavedPerRecovery", "baselineMttrSeconds"),
	}, "hoursSaved", "dollarSaved", "mttrDeltaSeconds", "assumptions"),
	"terminalRuns":    countT(),
	"mttrTrend":       arr(closedObj(map[string]any{"day": str(), "seconds": num()}, "day", "seconds")),
	"downtimeEndedMs": num(),
	"mttrMs":          nullableNum(),
	"recurrence": closedObj(map[string]any{
		"resolved": countT(), "recurred": countT(), "stayedFixedRate": nullableNum(), "windowDays": intT(),
	}, "resolved", "recurred", "stayedFixedRate", "windowDays"),
	"windowDays":     intT(),
	"costByProvider": arr(costProviderRow),
}, "successRate", "verifiedRecovery", "mttr", "p95Latency", "approvalsPending", "replayRate",
	"costThisWindow", "clustersResolved", "slaAttainment", "timeToFirstAction", "recurrenceRate",
	"valueEstimate", "terminalRuns", "mttrTrend", "downtimeEndedMs", "mttrMs", "recurrence",
	"windowDays", "costByProvider")

var failureCluster = closedObj(map[string]any{
	"signature": str(), "category": str(), "frequency": countT(),
	"affectedWorkflows": arr(closedObj(map[string]any{
		"workflowId": str(), "workflowName": str(), "count": countT(),
	}, "workflowId", "workflowName", "count")),
	"firstSeen": str(), "lastSeen": str(), "suggestedOwner": str(),
	"samples": arr(closedObj(map[string]any{
		"source": str(), "id": str(), "runId": str(),
	}, "source", "id", "runId")),
	"recurredAfterRecovery": boolT(),
}, "signature", "category", "frequency", "affectedWorkflows", "firstSeen", "lastSeen",
	"suggestedOwner", "samples", "recurredAfterRecovery")

var failureClusters = closedObj(map[string]any{
	"clusters":     arr(failureCluster),
	"totalSamples": countT(),
	"windowDays":   intT(),
}, "clusters", "totalSamples", "windowDays")

var recallEntry = closedObj(map[string]any{
	"id": str(), "kind": str(), "content": str(), "workflowId": str(), "runId": str(),
	"similarity": num(), "metadata": memoryMetadata,
}, "id", "kind", "content", "similarity")

var recoveryLedger = closedObj(map[string]any{
	"totalRecovered": countT(), "downtimeEndedMs": num(), "sinceIso": nullableString(),
}, "totalRecovered", "downtimeEndedMs", "sinceIso")

var recoveryWins = closedObj(map[string]any{"recovered": countT(), "windowDays": intT()}, "recovered", "windowDays")

var memoryConsentStatus = closedObj(map[string]any{
	"enabled": boolT(), "processEnabled": boolT(), "tenantEnabled": boolT(),
	"purge": closedObj(map[string]any{
		"status":       map[string]any{"type": "string", "enum": []any{"none", "unknown", "scheduled", "running"}},
		"scheduledFor": nullableString(),
	}, "status", "scheduledFor"),
}, "enabled", "processEnabled", "tenantEnabled", "purge")

var runUsage = closedObj(map[string]any{
	"loadedRows": countT(), "truncated": boolT(), "rowCap": countT(),
	"llm": closedObj(map[string]any{
		"calls": countT(), "inputTokens": countT(), "outputTokens": countT(), "totalTokens": countT(),
		"cachedInputTokens": countT(), "cacheCreationInputTokens": countT(),
		"knownCostUsd": num(), "unknownCostCalls": countT(),
	}, "calls", "inputTokens", "outputTokens", "totalTokens", "cachedInputTokens",
		"cacheCreationInputTokens", "knownCostUsd", "unknownCostCalls"),
	"memory": closedObj(map[string]any{
		"recalls": countT(), "commits": countT(), "failures": countT(),
		"kinds": arr(closedObj(map[string]any{
			"kind": str(), "recalls": countT(), "commits": countT(), "failures": countT(),
		}, "kind", "recalls", "commits", "failures")),
	}, "recalls", "commits", "failures", "kinds"),
}, "loadedRows", "truncated", "rowCap", "llm", "memory")

var validationBreakdown = closedObj(map[string]any{
	"key": str(), "total": countT(), "completed": countT(), "recovered": countT(),
	"acceptedLoss": countT(), "recoveryRatePercent": nullableNum(),
}, "key", "total", "completed", "recovered", "acceptedLoss", "recoveryRatePercent")

var nullableCount = map[string]any{"type": []any{"integer", "null"}}

var recoveryValidationReport = closedObj(map[string]any{
	"generatedAt": str(), "windowDays": intT(), "sampleLimit": countT(), "sampleCapped": boolT(),
	"totals": closedObj(map[string]any{
		"drills": countT(), "completed": countT(), "recovered": countT(), "acceptedLoss": countT(),
		"awaitingAction": countT(), "replayInProgress": countT(), "measurementIncomplete": countT(),
		"missingEvidence": countT(), "completionRatePercent": nullableNum(), "recoveryRatePercent": nullableNum(),
	}, "drills", "completed", "recovered", "acceptedLoss", "awaitingAction", "replayInProgress",
		"measurementIncomplete", "missingEvidence", "completionRatePercent", "recoveryRatePercent"),
	"resolution": closedObj(map[string]any{
		"operator": countT(), "automated": countT(), "unknown": countT(),
		"operatorInterventionRatePercent": nullableNum(),
	}, "operator", "automated", "unknown", "operatorInterventionRatePercent"),
	"timing": closedObj(map[string]any{
		"medianElapsedMs": nullableCount, "p90ElapsedMs": nullableCount,
		"averageElapsedMs": nullableCount, "p95ElapsedMs": nullableCount, "sampleSize": countT(),
	}, "medianElapsedMs", "p90ElapsedMs", "averageElapsedMs", "p95ElapsedMs", "sampleSize"),
	"byFailureMode":  arr(validationBreakdown),
	"byRecoveryPath": arr(validationBreakdown),
	"samples": arr(closedObj(map[string]any{
		"runId": str(), "runCreatedAt": str(), "packId": str(), "fixtureId": str(),
		"failureMode": str(), "recoveryPath": str(),
		"resolutionMode": map[string]any{"type": "string", "enum": []any{"operator", "automated", "unknown"}},
		"outcome":        nullable(drillOutcome),
	}, "runId", "runCreatedAt", "packId", "fixtureId", "failureMode", "recoveryPath", "resolutionMode", "outcome")),
}, "generatedAt", "windowDays", "sampleLimit", "sampleCapped", "totals", "resolution", "timing",
	"byFailureMode", "byRecoveryPath", "samples")

// Each Home section settles independently: a failed projection is reported
// as unavailable instead of erasing the others.
func homeSection(value Schema) map[string]any {
	return map[string]any{"oneOf": []any{
		closedObj(map[string]any{"status": map[string]any{"const": "ok"}, "value": value}, "status", "value"),
		closedObj(map[string]any{"status": map[string]any{"const": "unavailable"}}, "status"),
	}}
}

// The impact scope returns ledger, wins and queue only; the full scope adds
// the remaining sections.
var recoveryHome = closedObj(map[string]any{
	"scope":       map[string]any{"type": "string", "enum": []any{"full", "impact"}},
	"generatedAt": str(),
	"sections": closedObj(map[string]any{
		"ledger": homeSection(recoveryLedger),
		"wins":   homeSection(recoveryWins),
		"queue": homeSection(closedObj(map[string]any{
			"counts": closedObj(map[string]any{
				"total": countT(), "open": countT(), "replayed": countT(), "resolved": countT(),
			}, "total", "open", "replayed", "resolved"),
			"oldestOpen": nullable(deadLetterSummary),
		}, "counts", "oldestOpen")),
		"metrics":  homeSection(recoveryMetrics),
		"clusters": homeSection(failureClusters),
		"heatmap": homeSection(closedObj(map[string]any{
			"days": arr(closedObj(map[string]any{
				"day": str(), "failures": countT(), "recovered": countT(), "mttrSeconds": countT(),
			}, "day", "failures", "recovered", "mttrSeconds")),
			"windowDays": intT(),
		}, "days", "windowDays")),
		"cases": homeSection(closedObj(map[string]any{
			"cases": arr(closedObj(map[string]any{
				"id": str(), "runId": str(), "workflowId": nullableString(), "source": str(),
				"detectorId": str(), "detectorKind": str(), "action": str(), "state": str(),
				"message": str(), "createdAt": str(),
			}, "id", "runId", "workflowId", "source", "detectorId", "detectorKind", "action",
				"state", "message", "createdAt")),
		}, "cases")),
		"validation": homeSection(recoveryValidationReport),
	}, "ledger", "wins", "queue"),
}, "scope", "generatedAt", "sections")
