package contract

var agentCapability = strEnum([]string{"read", "propose", "test", "publish", "operate", "report"})

var agentClientScope = closedObj(map[string]any{"workflowIds": arr(str()), "tags": arr(str())}, "workflowIds", "tags")

// The token never appears here; only the issue and rotate responses carry it.
var agentClient = closedObj(map[string]any{
	"id": str(), "name": str(),
	"status":             strEnum([]string{"active", "revoked", "expired"}),
	"capabilities":       arr(agentCapability),
	"scope":              agentClientScope,
	"rateLimitPerMinute": map[string]any{"type": "integer", "minimum": 1},
	"tokenLast4":         str(), "createdBy": str(), "createdAt": str(), "tokenIssuedAt": str(), "expiresAt": str(),
	"revokedAt": nullableString(), "lastUsedAt": nullableString(),
	"gateTools": arr(str()), "captureContent": boolT(),
	"origin": strEnum([]string{"static", "oauth"}),
	"creatorAccess": closedObj(map[string]any{
		"state":              strEnum([]string{"member", "reduced", "removed", "unknown"}),
		"missingPermissions": arr(str()),
	}, "state", "missingPermissions"),
}, "id", "name", "status", "capabilities", "scope", "rateLimitPerMinute", "tokenLast4", "createdBy",
	"createdAt", "tokenIssuedAt", "expiresAt", "revokedAt", "lastUsedAt", "gateTools", "captureContent", "origin", "creatorAccess")

var agentClientList = closedObj(map[string]any{
	"clients":    arr(agentClient),
	"nextCursor": nullableString(),
	"capabilities": arr(closedObj(map[string]any{
		"name": agentCapability, "grantable": boolT(), "missingPermissions": arr(str()),
	}, "name", "grantable", "missingPermissions")),
	"limits": closedObj(map[string]any{
		"defaultExpiryDays": intT(), "maxExpiryDays": intT(),
		"defaultRateLimitPerMinute": intT(), "maxRateLimitPerMinute": intT(),
	}, "defaultExpiryDays", "maxExpiryDays", "defaultRateLimitPerMinute", "maxRateLimitPerMinute"),
}, "clients", "nextCursor", "capabilities", "limits")

var agentClientDetail = closedObj(map[string]any{
	"client": agentClient,
	"capabilities": arr(closedObj(map[string]any{
		"name": agentCapability, "tools": arr(str()), "missingPermissions": arr(str()),
	}, "name", "tools", "missingPermissions")),
	// Null when the caller could not read the source elsewhere.
	"recentCalls": nullable(arr(closedObj(map[string]any{
		"tool": str(), "allowed": boolT(), "at": nullableString(),
	}, "tool", "allowed", "at"))),
	"openRequests": nullable(arr(closedObj(map[string]any{
		"id": str(), "workflowId": str(), "reasons": arr(str()), "createdAt": str(), "expiresAt": str(),
	}, "id", "workflowId", "reasons", "createdAt", "expiresAt"))),
}, "client", "capabilities", "recentCalls", "openRequests")

var agentClientIssued = closedObj(map[string]any{"client": agentClient, "token": str()}, "client", "token")

var agentClientCreate = closedObj(map[string]any{
	"name": str(), "capabilities": arr(agentCapability), "scope": closedObj(map[string]any{
		"workflowIds": arr(str()), "tags": arr(str()),
	}),
	"expiresInDays": intT(), "rateLimitPerMinute": intT(),
	"gateTools": arr(str()), "captureContent": boolT(),
}, "name")
