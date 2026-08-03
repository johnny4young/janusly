// SCIM wire primitives: the WorkOS signature verifier
// (fail-closed reason ladder, constant-time), the event envelope parser,
// primary-email extraction, and the pure role derivation (highest-rank
// wins, defaultRole fallback).
package httpapi

import (
	"time"

	"github.com/johnny4young/janusly/internal/webhooksig"
)

const (
	scimActor        = "scim:webhook"
	scimBodyMaxBytes = 1 << 20 // 1 MiB, the API's JSON body cap

	// scimSignatureToleranceSeconds bounds the t= timestamp skew (±5 min),
	// the reference's TOLERANCE_WINDOWS_SEC.WEBHOOK_SIGNATURE.
	scimSignatureToleranceSeconds = 300

	// scimResyncMaxMembers caps one bulk re-sync sweep; a directory with
	// more active members reports capped=true and needs a follow-up run.
	scimResyncMaxMembers = 5000

	scimGroupStateDefaultLimit = 100
	scimGroupStateMaxLimit     = 200
)

// scimRoleRank orders the built-in roles for highest-wins derivation.
// Unknown / custom role names rank -1 so they never beat a built-in.
var scimRoleRank = map[string]int{"viewer": 1, "editor": 2, "admin": 3}

func isScimBuiltinRole(role string) bool { return scimRoleRank[role] > 0 }

// deriveScimRole picks the HIGHEST-rank role among the user's mapped
// groups; with no mapped group it returns defaultRole — byte-for-byte the
// pre-v2 flat-role behavior, so an org without mappings is unchanged.
func deriveScimRole(userGroupIDs []string, mappings map[string]string, defaultRole string) string {
	best, bestRank := "", 0
	for _, groupID := range userGroupIDs {
		role, ok := mappings[groupID]
		if !ok {
			continue
		}
		rank, known := scimRoleRank[role]
		if !known {
			rank = -1
		}
		if rank > bestRank {
			bestRank, best = rank, role
		}
	}
	if best == "" {
		return defaultRole
	}
	return best
}

/* ---------------------- WorkOS signature verification --------------------- */

// verifyWorkOsSignature checks a `WorkOS-Signature: t=<unix-ms>,v1=<hex>`
// header against the exact raw body bytes (HMAC-SHA256 over "<t>.<body>").
// An empty secret fails CLOSED. Returns (valid, reason).
func verifyWorkOsSignature(header, rawBody, secret string, now time.Time) (bool, string) {
	if secret == "" {
		return false, "missing_secret"
	}
	if header == "" {
		return false, "missing_header"
	}
	timestampRaw, candidates := webhooksig.ParseHeader(header, "t", "v1")
	if timestampRaw == "" || len(candidates) == 0 {
		return false, "malformed_header"
	}
	_, reason := webhooksig.Verify(timestampRaw, candidates, rawBody, secret, now.Unix(), webhooksig.Posture{
		Compose:               func(t, body string) string { return t + "." + body },
		ToleranceSeconds:      scimSignatureToleranceSeconds,
		TimestampMillis:       true,
		AsymmetricSkewReasons: true,
	})
	if reason != "" {
		return false, reason
	}
	return true, ""
}

/* ------------------------------ event shape ------------------------------- */

type scimEvent struct {
	ID        string
	Event     string
	CreatedAt string
	Data      map[string]any
}

// asScimEvent validates the WorkOS envelope: id/event/created_at strings
// plus a data object. Returns nil on any shape violation.
func asScimEvent(raw map[string]any) *scimEvent {
	id, _ := raw["id"].(string)
	eventType, _ := raw["event"].(string)
	createdAt, _ := raw["created_at"].(string)
	data, _ := raw["data"].(map[string]any)
	if id == "" || eventType == "" || createdAt == "" || data == nil {
		return nil
	}
	return &scimEvent{ID: id, Event: eventType, CreatedAt: createdAt, Data: data}
}

func scimStringField(data map[string]any, key string) string {
	value, _ := data[key].(string)
	return value
}

// scimPrimaryEmail extracts the user's email: a direct `email` string, the
// `primary: true` entry of an `emails` array (first entry fallback), or the
// same array nested under `custom_attributes`.
func scimPrimaryEmail(data map[string]any) string {
	if direct := scimStringField(data, "email"); direct != "" {
		return direct
	}
	if fromArray := scimPrimaryEmailFromArray(data["emails"]); fromArray != "" {
		return fromArray
	}
	if custom, ok := data["custom_attributes"].(map[string]any); ok {
		return scimPrimaryEmailFromArray(custom["emails"])
	}
	return ""
}

func scimPrimaryEmailFromArray(emails any) string {
	entries, ok := emails.([]any)
	if !ok {
		return ""
	}
	first := ""
	for _, entry := range entries {
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		value, _ := record["value"].(string)
		if value == "" {
			continue
		}
		if primary, _ := record["primary"].(bool); primary {
			return value
		}
		if first == "" {
			first = value
		}
	}
	return first
}

func extractScimDirectoryID(event *scimEvent) string {
	if direct := scimStringField(event.Data, "directory_id"); direct != "" {
		return direct
	}
	// Group user_added/user_removed events sometimes nest it under
	// data.directory.id — be defensive.
	if directory, ok := event.Data["directory"].(map[string]any); ok {
		return scimStringField(directory, "id")
	}
	return ""
}

// parseScimTimestamp accepts the RFC 3339 shapes WorkOS emits (with or
// without fractional seconds). Anything else is a malformed_timestamp.
func parseScimTimestamp(value string) (time.Time, bool) {
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}, false
	}
	return parsed, true
}

type scimResult struct {
	Processed bool
	Action    string
	Reason    string
}

func scimProcessed(action string) scimResult { return scimResult{Processed: true, Action: action} }
func scimSkipped(reason string) scimResult   { return scimResult{Reason: reason} }
