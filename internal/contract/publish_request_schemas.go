package contract

var publishRequestReason = strEnum([]string{
	"writes", "first_publish", "outbound", "callers", "triggers_changed", "steps_removed", "outputs_removed",
})

var publishRequest = closedObj(map[string]any{
	"id": str(), "workflowId": str(), "workflowName": nullableString(), "draftId": str(), "qualificationId": str(),
	"reasons":     arr(publishRequestReason),
	"requestedBy": str(), "requesterName": nullableString(), "onBehalfOf": str(),
	"draftedBy": str(), "drafterName": nullableString(),
	"status":    strEnum([]string{"pending", "published", "rejected", "expired", "superseded"}),
	"createdAt": str(), "expiresAt": str(),
	"decidedBy": nullableString(), "decidedAt": nullableString(), "decisionReason": nullableString(),
	"publishedVersionId": nullableString(),
	// Whether the caller may decide now and, if not, the refusal the decide
	// route would give.
	"viewer": closedObj(map[string]any{
		"canDecide": boolT(),
		"refusal": nullableStrEnum([]string{
			"settled", "permission", "requester", "second_person", "creator_unknown", "policy_unavailable", "stale", "stale_base",
		}),
	}, "canDecide", "refusal"),
}, "id", "workflowId", "workflowName", "draftId", "qualificationId", "reasons", "requestedBy", "requesterName",
	"onBehalfOf", "draftedBy", "drafterName", "status", "createdAt", "expiresAt", "decidedBy", "decidedAt",
	"decisionReason", "publishedVersionId", "viewer")

var qualificationStatus = strEnum([]string{"running", "passed", "failed"})

var publishRequestDetail = closedObj(map[string]any{
	"request":  publishRequest,
	"proposed": workflowDoc,
	// Null when the stored draft cannot be read as a workflow.
	"effects": nullable(arr(closedObj(map[string]any{
		"nodeId": str(), "type": str(), "tool": str(), "target": str(), "writes": boolT(), "credentials": arr(str()),
	}, "nodeId", "type", "tool", "target", "writes", "credentials"))),
	// What the draft takes away from production; null on a first publish.
	"changes": nullable(closedObj(map[string]any{
		"triggersChanged": arr(str()), "stepsRemoved": arr(str()), "outputsRemoved": arr(str()),
	}, "triggersChanged", "stepsRemoved", "outputsRemoved")),
	"qualification": closedObj(map[string]any{
		"status": qualificationStatus,
		"checks": arr(closedObj(map[string]any{
			"code": str(), "status": strEnum([]string{"passed", "failed"}),
			"path": str(), "message": str(), "fix": str(),
		}, "code", "status", "message")),
		"fixtureRuns": arr(closedObj(map[string]any{
			"fixture": str(), "runId": str(), "status": qualificationStatus, "detail": str(),
		}, "fixture", "status")),
	}, "status", "checks", "fixtureRuns"),
	"current": closedObj(map[string]any{
		"versionId": str(), "version": map[string]any{"type": "integer", "minimum": 1}, "document": workflowDoc,
	}, "versionId", "version", "document"),
}, "request", "proposed", "effects", "changes", "qualification")

var publishDecision = closedObj(map[string]any{"reason": map[string]any{"type": "string", "maxLength": 500}})
