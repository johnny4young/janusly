package contract

import (
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/recovery"
)

var workflowRollout = closedObj(map[string]any{
	"id": str(), "workflowId": str(), "baselineVersionId": str(), "canaryVersionId": str(),
	"trafficPercent": countT(), "minimumSampleSize": countT(), "minimumSuccessRatePercent": countT(),
	"status":            strEnum(domain.WorkflowRolloutStatuses),
	"baselineSucceeded": countT(), "baselineFailed": countT(),
	"canarySucceeded": countT(), "canaryFailed": countT(),
	"rolledBackReason": nullableString(),
	"createdAt":        str(), "updatedAt": str(),
	"endedAt": nullableString(), "lastOutcomeAt": nullableString(),
}, "id", "workflowId", "baselineVersionId", "canaryVersionId", "trafficPercent",
	"minimumSampleSize", "minimumSuccessRatePercent", "status", "baselineSucceeded",
	"baselineFailed", "canarySucceeded", "canaryFailed", "rolledBackReason", "createdAt",
	"updatedAt", "endedAt", "lastOutcomeAt")

var rolloutEnvelope = closedObj(map[string]any{"rollout": workflowRollout}, "rollout")

var qualificationSummary = closedObj(map[string]any{
	"datasetVersion": str(), "datasetDigest": str(), "mode": str(), "status": str(),
	"baselineCaseCount": countT(), "candidateCaseCount": countT(),
	"candidateAssertionCount": countT(), "passedCandidateAssertions": countT(),
	"failedCandidateAssertions": countT(), "regressionCount": countT(),
	"coverageFailureCount": countT(), "baselineDatasetValid": boolT(),
	"failures": arr(closedObj(map[string]any{
		"dataset": strEnum(recovery.QualificationFailureDatasets), "fixtureId": str(), "sourceNodeId": str(),
		"expected": str(), "actual": str(), "reason": strEnum(recovery.QualificationFailureReasons),
		"violations": arr(closedObj(map[string]any{
			"detectorId": str(), "sourceNodeId": str(), "kind": str(),
			"action": str(), "message": str(), "details": arr(str()),
		}, "detectorId", "sourceNodeId", "kind", "action", "message")),
	}, "dataset", "fixtureId", "sourceNodeId", "expected", "actual", "reason")),
	"failuresTruncated": boolT(),
}, "datasetVersion", "datasetDigest", "mode", "status", "baselineCaseCount",
	"candidateCaseCount", "candidateAssertionCount", "passedCandidateAssertions",
	"failedCandidateAssertions", "regressionCount", "coverageFailureCount",
	"baselineDatasetValid", "failures", "failuresTruncated")

var workflowQualification = closedObj(map[string]any{
	"id": str(), "workflowId": str(), "baselineVersionId": str(), "candidateVersionId": str(),
	"datasetVersion": str(), "datasetDigest": str(), "mode": str(), "status": str(),
	"summary": qualificationSummary, "createdAt": str(),
}, "id", "workflowId", "baselineVersionId", "candidateVersionId", "datasetVersion",
	"datasetDigest", "mode", "status", "summary", "createdAt")

// summary appears only when the version pair needs no qualification.
var qualificationEnvelope = closedObj(map[string]any{
	"required":      boolT(),
	"qualification": nullable(workflowQualification),
	"summary":       qualificationSummary,
}, "required", "qualification")
