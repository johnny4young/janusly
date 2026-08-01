// SCIM directory sync (reference apps/api/src/scim-event-handler.ts +
// scim-resync.ts + routes/scim-routes.ts + workos-webhook.ts): the inbound
// WorkOS Directory Sync webhook, the pure event dispatcher with its three
// deterministic guards (replay → malformed timestamp → per-type dispatch,
// with out-of-order / resurrection / collision guards inside the user
// handlers), group→role derivation (highest-rank wins, defaultRole
// fallback), admin CRUD for directories + group→role mappings, and the
// bulk role re-sync.
//
// Invariants ported verbatim:
//   - The webhook ALWAYS 200s on signature-pass + parseable JSON regardless
//     of the guard outcome (WorkOS retries non-2xx for hours); real I/O
//     failures still 5xx so WorkOS retries those.
//   - The replay claim (scim_processed_events) is RELEASED when dispatch
//     fails with a real error, so the next WorkOS retry re-processes
//     instead of being mistaken for an already-handled event.
//   - Collision asymmetry: the create path absorbs SCIM-owned rows
//     (invited_by = "scim:webhook") and blocks human-invited ones; the
//     re-key path blocks ANY pre-existing row at the new email.
//   - The org-binding seam is the scim_directories row matched by
//     provider_directory_id — never an org id from the upstream payload.
//   - Membership writes are keyed on (org_id, lower(email)); the re-sync
//     omits invited_by so the original provisioning actor survives.
package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/orgconfig"
	"github.com/johnny4young/janusly/go/internal/store"
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
	timestampStr, signatureHex := "", ""
	for _, part := range strings.Split(header, ",") {
		key, value, found := strings.Cut(strings.TrimSpace(part), "=")
		if !found {
			continue
		}
		switch key {
		case "t":
			timestampStr = value
		case "v1":
			signatureHex = value
		}
	}
	if timestampStr == "" || signatureHex == "" {
		return false, "malformed_header"
	}
	if _, err := hex.DecodeString(signatureHex); err != nil || len(signatureHex)%2 != 0 {
		return false, "malformed_header"
	}
	timestampMs, err := strconv.ParseInt(timestampStr, 10, 64)
	if err != nil || timestampMs <= 0 {
		return false, "malformed_header"
	}
	deltaMs := now.UnixMilli() - timestampMs
	if deltaMs > scimSignatureToleranceSeconds*1000 {
		return false, "expired"
	}
	if deltaMs < -scimSignatureToleranceSeconds*1000 {
		return false, "future_timestamp"
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(timestampStr + "." + rawBody))
	expectedHex := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expectedHex), []byte(signatureHex)) {
		return false, "signature_mismatch"
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

/* ------------------------------ dispatcher -------------------------------- */

func (s *V1Server) scimAudit(ctx context.Context, orgID string, action audit.Action, targetType, targetID string, metadata map[string]any) {
	audit.WriteAs(ctx, s.pool, orgID, scimActor, action, audit.Options{
		TargetType: targetType, TargetID: targetID, Metadata: metadata,
	})
}

// handleScimEvent runs the deterministic guard ladder and dispatches one
// event. Guard rejections audit + return a skipped result; real I/O errors
// release the replay claim (best-effort) and bubble up so the route 5xxs.
func (s *V1Server) handleScimEvent(ctx context.Context, directory store.ScimDirectory, event *scimEvent) (scimResult, error) {
	q := store.New(s.pool)
	orgID := directory.OrgID

	// Replay guard: INSERT … ON CONFLICT DO NOTHING; 0 rows = replay.
	fresh, err := q.RecordScimProcessedEvent(ctx, store.RecordScimProcessedEventParams{
		EventID: event.ID, OrgID: orgID, ScimDirectoryID: directory.ID, EventType: event.Event,
	})
	if err != nil {
		return scimResult{}, err
	}
	if fresh == 0 {
		s.scimAudit(ctx, orgID, "scim.webhook.event_replayed", "scim_event", event.ID, map[string]any{
			"eventType": event.Event, "scimDirectoryId": directory.ID,
		})
		return scimSkipped("event_replayed"), nil
	}

	eventTimestamp, ok := parseScimTimestamp(event.CreatedAt)
	if !ok {
		s.scimAudit(ctx, orgID, "scim.webhook.malformed_timestamp", "scim_event", event.ID, map[string]any{
			"eventType": event.Event,
		})
		return scimSkipped("malformed_timestamp"), nil
	}

	// The event id is claimed. A dispatch ERROR (DB outage mid-handler)
	// releases the claim so WorkOS' next retry re-processes; without this a
	// transient blip would silently lose the event.
	result, err := s.dispatchScimEvent(ctx, directory, event, eventTimestamp)
	if err != nil {
		_ = q.DeleteScimProcessedEvent(ctx, store.DeleteScimProcessedEventParams{
			EventID: event.ID, OrgID: orgID,
		})
		return scimResult{}, err
	}
	if result.Processed {
		if err := q.RecordScimDirectorySync(ctx, store.RecordScimDirectorySyncParams{
			ID: directory.ID, OrgID: orgID,
		}); err != nil {
			return scimResult{}, err
		}
	}
	return result, nil
}

func (s *V1Server) dispatchScimEvent(ctx context.Context, directory store.ScimDirectory, event *scimEvent, eventTimestamp time.Time) (scimResult, error) {
	switch event.Event {
	case "dsync.user.created":
		return s.scimUserCreated(ctx, directory, event, eventTimestamp)
	case "dsync.user.updated":
		return s.scimUserUpdated(ctx, directory, event, eventTimestamp)
	case "dsync.user.deleted":
		return s.scimUserDeleted(ctx, directory, event, eventTimestamp)
	case "dsync.group.created", "dsync.group.updated":
		return s.scimGroupUpsert(ctx, directory, event)
	case "dsync.group.deleted":
		return s.scimGroupDeleted(ctx, directory, event)
	case "dsync.group.user_added":
		return s.scimGroupUserAdded(ctx, directory, event)
	case "dsync.group.user_removed":
		return s.scimGroupUserRemoved(ctx, directory, event)
	default:
		s.scimAudit(ctx, directory.OrgID, "scim.webhook.unknown_event", "scim_event", event.ID, map[string]any{
			"eventType": event.Event,
		})
		return scimSkipped("unknown_event"), nil
	}
}

/* ----------------------------- user handlers ------------------------------ */

func (s *V1Server) scimUserCreated(ctx context.Context, directory store.ScimDirectory, event *scimEvent, eventTimestamp time.Time) (scimResult, error) {
	q := store.New(s.pool)
	orgID := directory.OrgID
	providerUserID := scimStringField(event.Data, "id")
	email := scimPrimaryEmail(event.Data)
	if providerUserID == "" || email == "" {
		missing := "email"
		if providerUserID == "" {
			missing = "id"
		}
		s.scimAudit(ctx, orgID, "scim.webhook.malformed_payload", "scim_event", event.ID, map[string]any{
			"eventType": event.Event, "missingFields": missing,
		})
		return scimSkipped("malformed_payload"), nil
	}

	existing, err := q.GetScimUserState(ctx, store.GetScimUserStateParams{
		ScimDirectoryID: directory.ID, ProviderUserID: providerUserID,
	})
	hasState := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return scimResult{}, err
	}

	// Resurrection guard: a create for an INACTIVE state row whose
	// timestamp is not newer than the deprovision event is a late replayed
	// create, not a genuine re-provision.
	if hasState && !existing.Active && existing.LastEventTimestamp != nil &&
		!eventTimestamp.After(*existing.LastEventTimestamp) {
		s.scimAudit(ctx, orgID, "scim.user.resurrection_blocked", "scim_user", providerUserID, map[string]any{
			"email": email, "scimDirectoryId": directory.ID, "eventId": event.ID,
			"incomingTimestamp":  eventTimestamp.Format(time.RFC3339),
			"lastEventTimestamp": existing.LastEventTimestamp.Format(time.RFC3339),
		})
		return scimSkipped("resurrection_blocked"), nil
	}

	// Out-of-order guard (active rows only — the inactive path is the
	// resurrection guard's).
	if hasState && existing.Active && existing.LastEventTimestamp != nil &&
		!eventTimestamp.After(*existing.LastEventTimestamp) {
		s.scimAudit(ctx, orgID, "scim.webhook.out_of_order", "scim_event", event.ID, map[string]any{
			"eventType": event.Event, "providerUserId": providerUserID,
			"incomingTimestamp":  eventTimestamp.Format(time.RFC3339),
			"lastEventTimestamp": existing.LastEventTimestamp.Format(time.RFC3339),
		})
		return scimSkipped("out_of_order"), nil
	}

	// allowedEmailDomains policy gate (org config; empty = no restriction).
	if allow := scimAllowedDomains(ctx, s.pool, orgID); len(allow) > 0 {
		domain := ""
		if at := strings.LastIndex(email, "@"); at >= 0 {
			domain = strings.ToLower(email[at+1:])
		}
		if domain == "" || !containsString(allow, domain) {
			s.scimAudit(ctx, orgID, "scim.user.provision_rejected", "scim_user", providerUserID, map[string]any{
				"email": email, "domain": domain, "scimDirectoryId": directory.ID,
				"reason": "domain_not_allowed", "allowedDomains": allow,
			})
			return scimSkipped("domain_not_allowed"), nil
		}
	}

	wasReactivation := hasState && !existing.Active
	lowerEmail := strings.ToLower(strings.TrimSpace(email))

	// Create-path collision guard: absorb a SCIM-owned row at this email
	// (this directory's own lifecycle — re-attach, redelivery, group-first
	// provisioning); a human-invited row blocks BEFORE any write so the
	// existing principal stays fully intact.
	member, err := q.FindScimMemberByEmail(ctx, store.FindScimMemberByEmailParams{
		OrgID: orgID, Email: pgtype.Text{String: lowerEmail, Valid: true},
	})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return scimResult{}, err
	}
	if err == nil && member.InvitedBy.String != scimActor {
		s.scimAudit(ctx, orgID, "scim.user.provision_collision", "scim_user", providerUserID, map[string]any{
			"email": lowerEmail, "conflictingRole": member.Role,
			"conflictingInvitedBy": textOrNull(member.InvitedBy),
			"scimDirectoryId":      directory.ID, "eventId": event.ID,
		})
		return scimSkipped("provision_collision"), nil
	}

	if err := s.upsertScimUserState(ctx, directory, providerUserID, lowerEmail, event, eventTimestamp); err != nil {
		return scimResult{}, err
	}
	role, err := s.resolveDerivedScimRole(ctx, directory, providerUserID)
	if err != nil {
		return scimResult{}, err
	}
	if err := s.upsertScimMembership(ctx, orgID, lowerEmail, role, scimActor); err != nil {
		return scimResult{}, err
	}
	s.scimAudit(ctx, orgID, "scim.user.provisioned", "scim_user", providerUserID, map[string]any{
		"email": lowerEmail, "role": role, "scimDirectoryId": directory.ID,
		"eventId": event.ID, "reactivated": wasReactivation,
	})
	return scimProcessed("provisioned"), nil
}

func (s *V1Server) scimUserUpdated(ctx context.Context, directory store.ScimDirectory, event *scimEvent, eventTimestamp time.Time) (scimResult, error) {
	q := store.New(s.pool)
	orgID := directory.OrgID
	providerUserID := scimStringField(event.Data, "id")
	email := scimPrimaryEmail(event.Data)
	if providerUserID == "" || email == "" {
		s.scimAudit(ctx, orgID, "scim.webhook.malformed_payload", "scim_event", event.ID, map[string]any{
			"eventType": event.Event,
		})
		return scimSkipped("malformed_payload"), nil
	}

	existing, err := q.GetScimUserState(ctx, store.GetScimUserStateParams{
		ScimDirectoryID: directory.ID, ProviderUserID: providerUserID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// No state yet — treat the update as a create (defensive).
			return s.scimUserCreated(ctx, directory, event, eventTimestamp)
		}
		return scimResult{}, err
	}

	if existing.LastEventTimestamp != nil && !eventTimestamp.After(*existing.LastEventTimestamp) {
		s.scimAudit(ctx, orgID, "scim.webhook.out_of_order", "scim_event", event.ID, map[string]any{
			"eventType": event.Event, "providerUserId": providerUserID,
			"incomingTimestamp":  eventTimestamp.Format(time.RFC3339),
			"lastEventTimestamp": existing.LastEventTimestamp.Format(time.RFC3339),
		})
		return scimSkipped("out_of_order"), nil
	}

	// Reviving a deprovisioned user via UPDATE is disallowed.
	if !existing.Active {
		s.scimAudit(ctx, orgID, "scim.user.resurrection_blocked", "scim_user", providerUserID, map[string]any{
			"email": email, "scimDirectoryId": directory.ID, "eventId": event.ID,
			"reason": "update_while_inactive",
		})
		return scimSkipped("resurrection_blocked"), nil
	}

	lowerEmail := strings.ToLower(strings.TrimSpace(email))
	oldEmail := strings.ToLower(existing.Email)

	if lowerEmail != oldEmail {
		// Re-key collision guard: the NEW email should be empty — ANY row
		// there belongs to a different principal, so refuse without
		// deleting, overwriting, or advancing state.
		if target, err := q.FindScimMemberByEmail(ctx, store.FindScimMemberByEmailParams{
			OrgID: orgID, Email: pgtype.Text{String: lowerEmail, Valid: true},
		}); err == nil {
			s.scimAudit(ctx, orgID, "scim.user.rekey_collision", "scim_user", providerUserID, map[string]any{
				"fromEmail": oldEmail, "toEmail": lowerEmail,
				"conflictingRole":      target.Role,
				"conflictingInvitedBy": textOrNull(target.InvitedBy),
				"scimDirectoryId":      directory.ID, "eventId": event.ID,
			})
			return scimSkipped("rekey_collision"), nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return scimResult{}, err
		}
		if _, err := q.DeleteScimMembershipByEmail(ctx, store.DeleteScimMembershipByEmailParams{
			OrgID: orgID, Email: pgtype.Text{String: oldEmail, Valid: true},
		}); err != nil {
			return scimResult{}, err
		}
	}

	if err := s.upsertScimUserState(ctx, directory, providerUserID, lowerEmail, event, eventTimestamp); err != nil {
		return scimResult{}, err
	}
	role, err := s.resolveDerivedScimRole(ctx, directory, providerUserID)
	if err != nil {
		return scimResult{}, err
	}
	if err := s.upsertScimMembership(ctx, orgID, lowerEmail, role, scimActor); err != nil {
		return scimResult{}, err
	}
	metadata := map[string]any{
		"email": lowerEmail, "role": role, "scimDirectoryId": directory.ID, "eventId": event.ID,
	}
	if oldEmail != lowerEmail {
		metadata["previousEmail"] = oldEmail
	}
	s.scimAudit(ctx, orgID, "scim.user.updated", "scim_user", providerUserID, metadata)
	return scimProcessed("updated"), nil
}

func (s *V1Server) scimUserDeleted(ctx context.Context, directory store.ScimDirectory, event *scimEvent, eventTimestamp time.Time) (scimResult, error) {
	q := store.New(s.pool)
	orgID := directory.OrgID
	providerUserID := scimStringField(event.Data, "id")
	if providerUserID == "" {
		s.scimAudit(ctx, orgID, "scim.webhook.malformed_payload", "scim_event", event.ID, map[string]any{
			"eventType": event.Event,
		})
		return scimSkipped("malformed_payload"), nil
	}

	existing, err := q.GetScimUserState(ctx, store.GetScimUserStateParams{
		ScimDirectoryID: directory.ID, ProviderUserID: providerUserID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// A delete for an unknown user can trail early group events;
			// clear those orphan join rows so a later genuine create can't
			// inherit stale groups from the old lifecycle.
			if err := q.DeleteScimUserGroupsForUser(ctx, store.DeleteScimUserGroupsForUserParams{
				OrgID: orgID, ScimDirectoryID: directory.ID, ProviderUserID: providerUserID,
			}); err != nil {
				return scimResult{}, err
			}
			s.scimAudit(ctx, orgID, "scim.webhook.unknown_user", "scim_event", event.ID, map[string]any{
				"eventType": event.Event, "providerUserId": providerUserID,
			})
			return scimSkipped("unknown_user"), nil
		}
		return scimResult{}, err
	}

	if existing.LastEventTimestamp != nil && !eventTimestamp.After(*existing.LastEventTimestamp) {
		s.scimAudit(ctx, orgID, "scim.webhook.out_of_order", "scim_event", event.ID, map[string]any{
			"eventType": event.Event, "providerUserId": providerUserID,
			"incomingTimestamp":  eventTimestamp.Format(time.RFC3339),
			"lastEventTimestamp": existing.LastEventTimestamp.Format(time.RFC3339),
		})
		return scimSkipped("out_of_order"), nil
	}

	if _, err := q.DeleteScimMembershipByEmail(ctx, store.DeleteScimMembershipByEmailParams{
		OrgID: orgID, Email: pgtype.Text{String: strings.ToLower(existing.Email), Valid: true},
	}); err != nil {
		return scimResult{}, err
	}
	if err := q.DeleteScimUserGroupsForUser(ctx, store.DeleteScimUserGroupsForUserParams{
		OrgID: orgID, ScimDirectoryID: directory.ID, ProviderUserID: providerUserID,
	}); err != nil {
		return scimResult{}, err
	}
	if err := q.MarkScimUserInactive(ctx, store.MarkScimUserInactiveParams{
		ID:                 existing.ID,
		LastEventID:        pgtype.Text{String: event.ID, Valid: true},
		LastEventTimestamp: &eventTimestamp,
	}); err != nil {
		return scimResult{}, err
	}
	s.scimAudit(ctx, orgID, "scim.user.deprovisioned", "scim_user", providerUserID, map[string]any{
		"email": existing.Email, "scimDirectoryId": directory.ID, "eventId": event.ID,
	})
	return scimProcessed("deprovisioned"), nil
}

/* ----------------------------- group handlers ----------------------------- */

// Membership events rely on the top-level event-id replay guard plus the
// idempotent scim_user_groups join (ON CONFLICT DO NOTHING); they carry NO
// per-membership out-of-order guard — the join table has no timestamp, so
// the derived role reflects whatever join rows exist (eventual
// consistency). A reordered add/remove pair leaves a stale role one rank
// off until the next membership event corrects it; it can never escalate
// beyond an admin-configured mapping. Accepted v1 posture (reference).

func (s *V1Server) scimGroupUpsert(ctx context.Context, directory store.ScimDirectory, event *scimEvent) (scimResult, error) {
	providerGroupID := scimStringField(event.Data, "id")
	name := scimStringField(event.Data, "name")
	if providerGroupID == "" || name == "" {
		s.scimAudit(ctx, directory.OrgID, "scim.webhook.malformed_payload", "scim_event", event.ID, map[string]any{
			"eventType": event.Event,
		})
		return scimSkipped("malformed_payload"), nil
	}
	if err := store.New(s.pool).UpsertScimGroupState(ctx, store.UpsertScimGroupStateParams{
		ID: s.newID(), OrgID: directory.OrgID, ScimDirectoryID: directory.ID,
		ProviderGroupID: providerGroupID, Name: name,
	}); err != nil {
		return scimResult{}, err
	}
	s.scimAudit(ctx, directory.OrgID, "scim.group.synced", "scim_group", providerGroupID, map[string]any{
		"eventType": event.Event, "name": name, "scimDirectoryId": directory.ID,
	})
	return scimProcessed("group_synced"), nil
}

func (s *V1Server) scimGroupDeleted(ctx context.Context, directory store.ScimDirectory, event *scimEvent) (scimResult, error) {
	q := store.New(s.pool)
	providerGroupID := scimStringField(event.Data, "id")
	if providerGroupID == "" {
		s.scimAudit(ctx, directory.OrgID, "scim.webhook.malformed_payload", "scim_event", event.ID, map[string]any{
			"eventType": event.Event,
		})
		return scimSkipped("malformed_payload"), nil
	}
	if existing, err := q.GetScimGroupState(ctx, store.GetScimGroupStateParams{
		ScimDirectoryID: directory.ID, ProviderGroupID: providerGroupID,
	}); err == nil {
		if err := q.DeleteScimGroupState(ctx, existing.ID); err != nil {
			return scimResult{}, err
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return scimResult{}, err
	}
	// Capture affected users BEFORE deleting the join rows, then recompute
	// after cleanup so active members immediately lose roles derived from
	// the deleted group.
	affected, err := q.ListScimUserIDsForGroup(ctx, store.ListScimUserIDsForGroupParams{
		OrgID: directory.OrgID, ScimDirectoryID: directory.ID, ProviderGroupID: providerGroupID,
	})
	if err != nil {
		return scimResult{}, err
	}
	if err := q.DeleteScimUserGroupsForGroup(ctx, store.DeleteScimUserGroupsForGroupParams{
		OrgID: directory.OrgID, ScimDirectoryID: directory.ID, ProviderGroupID: providerGroupID,
	}); err != nil {
		return scimResult{}, err
	}
	for _, providerUserID := range affected {
		if err := s.recomputeScimMemberRole(ctx, directory, event, providerUserID, providerGroupID, "removed"); err != nil {
			return scimResult{}, err
		}
	}
	s.scimAudit(ctx, directory.OrgID, "scim.group.synced", "scim_group", providerGroupID, map[string]any{
		"eventType": event.Event, "deleted": true, "scimDirectoryId": directory.ID,
	})
	return scimProcessed("group_deleted"), nil
}

func (s *V1Server) scimGroupUserAdded(ctx context.Context, directory store.ScimDirectory, event *scimEvent) (scimResult, error) {
	providerUserID := scimStringField(event.Data, "user_id")
	providerGroupID := scimStringField(event.Data, "directory_group_id")
	if providerUserID == "" || providerGroupID == "" {
		s.scimAudit(ctx, directory.OrgID, "scim.webhook.malformed_payload", "scim_event", event.ID, map[string]any{
			"eventType": event.Event,
		})
		return scimSkipped("malformed_payload"), nil
	}
	// Persist the membership FIRST so the recompute sees the new group.
	if err := store.New(s.pool).AddScimUserGroup(ctx, store.AddScimUserGroupParams{
		ID: s.newID(), OrgID: directory.OrgID, ScimDirectoryID: directory.ID,
		ProviderUserID: providerUserID, ProviderGroupID: providerGroupID,
	}); err != nil {
		return scimResult{}, err
	}
	if err := s.recomputeScimMemberRole(ctx, directory, event, providerUserID, providerGroupID, "added"); err != nil {
		return scimResult{}, err
	}
	return scimProcessed("group_membership_added"), nil
}

func (s *V1Server) scimGroupUserRemoved(ctx context.Context, directory store.ScimDirectory, event *scimEvent) (scimResult, error) {
	providerUserID := scimStringField(event.Data, "user_id")
	providerGroupID := scimStringField(event.Data, "directory_group_id")
	if providerUserID == "" || providerGroupID == "" {
		s.scimAudit(ctx, directory.OrgID, "scim.webhook.malformed_payload", "scim_event", event.ID, map[string]any{
			"eventType": event.Event,
		})
		return scimSkipped("malformed_payload"), nil
	}
	// Drop the membership FIRST so the recompute excludes the removed
	// group (a removal may lower the role back toward defaultRole).
	if err := store.New(s.pool).RemoveScimUserGroup(ctx, store.RemoveScimUserGroupParams{
		OrgID: directory.OrgID, ScimDirectoryID: directory.ID,
		ProviderUserID: providerUserID, ProviderGroupID: providerGroupID,
	}); err != nil {
		return scimResult{}, err
	}
	if err := s.recomputeScimMemberRole(ctx, directory, event, providerUserID, providerGroupID, "removed"); err != nil {
		return scimResult{}, err
	}
	return scimProcessed("group_membership_removed"), nil
}

/* --------------------------- shared write paths --------------------------- */

func (s *V1Server) upsertScimUserState(ctx context.Context, directory store.ScimDirectory, providerUserID, lowerEmail string, event *scimEvent, eventTimestamp time.Time) error {
	firstName := scimStringField(event.Data, "first_name")
	lastName := scimStringField(event.Data, "last_name")
	return store.New(s.pool).UpsertScimUserState(ctx, store.UpsertScimUserStateParams{
		ID: s.newID(), OrgID: directory.OrgID, ScimDirectoryID: directory.ID,
		ProviderUserID: providerUserID, Email: lowerEmail,
		FirstName:          pgtype.Text{String: firstName, Valid: firstName != ""},
		LastName:           pgtype.Text{String: lastName, Valid: lastName != ""},
		LastEventID:        pgtype.Text{String: event.ID, Valid: true},
		LastEventTimestamp: &eventTimestamp,
	})
}

// resolveDerivedScimRole loads the user's current groups + the directory's
// mappings and derives the member role (highest-rank mapped role, else the
// directory's defaultRole).
func (s *V1Server) resolveDerivedScimRole(ctx context.Context, directory store.ScimDirectory, providerUserID string) (string, error) {
	q := store.New(s.pool)
	groupIDs, err := q.ListScimUserGroupIDs(ctx, store.ListScimUserGroupIDsParams{
		OrgID: directory.OrgID, ScimDirectoryID: directory.ID, ProviderUserID: providerUserID,
	})
	if err != nil {
		return "", err
	}
	mappings, err := s.scimGroupRoleMappingsMap(ctx, directory)
	if err != nil {
		return "", err
	}
	return deriveScimRole(groupIDs, mappings, directory.DefaultRole), nil
}

func (s *V1Server) scimGroupRoleMappingsMap(ctx context.Context, directory store.ScimDirectory) (map[string]string, error) {
	rows, err := store.New(s.pool).ListScimGroupRoleMappings(ctx, store.ListScimGroupRoleMappingsParams{
		OrgID: directory.OrgID, ScimDirectoryID: directory.ID,
	})
	if err != nil {
		return nil, err
	}
	mappings := make(map[string]string, len(rows))
	for _, row := range rows {
		mappings[row.ProviderGroupID] = row.Role
	}
	return mappings, nil
}

// recomputeScimMemberRole re-derives a member's role after a group
// membership change. With no ACTIVE state row (group event before the user
// is provisioned, or a deprovisioned user) the join row is already
// persisted by the caller — a later create/update derives the role — so
// only the membership-change audit is written.
func (s *V1Server) recomputeScimMemberRole(ctx context.Context, directory store.ScimDirectory, event *scimEvent, providerUserID, providerGroupID, change string) error {
	q := store.New(s.pool)
	orgID := directory.OrgID
	userState, err := q.GetScimUserState(ctx, store.GetScimUserStateParams{
		ScimDirectoryID: directory.ID, ProviderUserID: providerUserID,
	})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if err != nil || !userState.Active {
		s.scimAudit(ctx, orgID, "scim.group.membership_changed", "scim_user", providerUserID, map[string]any{
			"eventType": event.Event, "change": change, "providerGroupId": providerGroupID,
			"scimDirectoryId": directory.ID, "roleRecomputed": false,
		})
		return nil
	}
	derivedRole, err := s.resolveDerivedScimRole(ctx, directory, providerUserID)
	if err != nil {
		return err
	}
	lowerEmail := strings.ToLower(userState.Email)
	if err := s.upsertScimMembership(ctx, orgID, lowerEmail, derivedRole, scimActor); err != nil {
		return err
	}
	s.scimAudit(ctx, orgID, "scim.group.membership_changed", "scim_user", providerUserID, map[string]any{
		"eventType": event.Event, "change": change, "providerGroupId": providerGroupID,
		"scimDirectoryId": directory.ID, "email": lowerEmail,
		"derivedRole": derivedRole, "roleRecomputed": true,
	})
	return nil
}

// upsertScimMembership writes the (org_id, lower(email))-keyed membership
// row. invitedBy "" preserves the row's current inviter (the re-sync
// path); a non-empty inviter is written on both update and insert.
func (s *V1Server) upsertScimMembership(ctx context.Context, orgID, lowerEmail, role, invitedBy string) error {
	q := store.New(s.pool)
	inviter := pgtype.Text{String: invitedBy, Valid: invitedBy != ""}
	existing, err := q.FindScimMemberByEmail(ctx, store.FindScimMemberByEmailParams{
		OrgID: orgID, Email: pgtype.Text{String: lowerEmail, Valid: true},
	})
	if err == nil {
		_, err = q.UpdateScimMembershipByEmail(ctx, store.UpdateScimMembershipByEmailParams{
			ID: existing.ID, OrgID: orgID,
			Email: pgtype.Text{String: lowerEmail, Valid: true},
			Role:  role, InvitedBy: inviter,
		})
		return err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	return q.InsertScimMembership(ctx, store.InsertScimMembershipParams{
		ID: s.newID(), OrgID: orgID, Email: lowerEmail, Role: role, InvitedBy: inviter,
	})
}

// scimAllowedDomains reads the auth.allowedEmailDomains org config
// (comma-separated; empty = no restriction) as a trimmed lowercase list.
func scimAllowedDomains(ctx context.Context, pool orgconfig.Querier, orgID string) []string {
	raw, _ := orgconfig.LoadValue(ctx, pool, orgID, "auth.allowedEmailDomains").(string)
	var domains []string
	for _, entry := range strings.Split(raw, ",") {
		if trimmed := strings.ToLower(strings.TrimSpace(entry)); trimmed != "" {
			domains = append(domains, trimmed)
		}
	}
	return domains
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

/* ------------------------------- routes ----------------------------------- */

func scimDirectoryView(row store.ScimDirectory) map[string]any {
	return map[string]any{
		"id": row.ID, "orgId": row.OrgID, "providerDirectoryId": row.ProviderDirectoryID,
		"directoryType": textOrNull(row.DirectoryType), "defaultRole": row.DefaultRole,
		"status": row.Status, "lastSyncedAt": row.LastSyncedAt, "createdAt": row.CreatedAt,
	}
}

func scimGroupView(row store.ScimGroupState) map[string]any {
	return map[string]any{
		"id": row.ID, "providerGroupId": row.ProviderGroupID, "name": row.Name,
		"lastSyncedAt": row.LastSyncedAt,
	}
}

func scimMappingView(row store.ScimGroupRoleMapping) map[string]any {
	return map[string]any{
		"id": row.ID, "providerGroupId": row.ProviderGroupID, "role": row.Role,
		"scimDirectoryId": row.ScimDirectoryID, "createdBy": textOrNull(row.CreatedBy),
		"updatedBy": textOrNull(row.UpdatedBy), "createdAt": row.CreatedAt, "updatedAt": row.UpdatedAt,
	}
}

func (s *V1Server) getScimDirectoryForOrg(ctx context.Context, orgID string) (store.ScimDirectory, bool, error) {
	directory, err := store.New(s.pool).GetScimDirectoryByOrgID(ctx, orgID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return store.ScimDirectory{}, false, nil
		}
		return store.ScimDirectory{}, false, err
	}
	return directory, true, nil
}

func (s *V1Server) mountScimRoutes(mux *http.ServeMux) {
	// === Admin CRUD on scim_directories ===
	mux.HandleFunc("GET /org/scim/directories", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		rows, err := store.New(s.pool).ListScimDirectories(r.Context(), rc.orgID)
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		views := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			views = append(views, scimDirectoryView(row))
		}
		writeLegacy(w, opOK(map[string]any{"directories": views}))
	}))

	mux.HandleFunc("POST /org/scim/directories", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct {
			ProviderDirectoryID string `json:"providerDirectoryId"`
			DirectoryType       string `json:"directoryType"`
			DefaultRole         string `json:"defaultRole"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeLegacy(w, opError(http.StatusBadRequest, "scim_invalid_body", "invalid body", nil))
			return
		}
		providerDirectoryID := strings.TrimSpace(body.ProviderDirectoryID)
		if providerDirectoryID == "" {
			writeLegacy(w, opError(http.StatusBadRequest, "scim_provider_directory_id_required",
				"providerDirectoryId is required (e.g. directory_…)", nil))
			return
		}
		defaultRole := "viewer"
		if body.DefaultRole != "" {
			if !isScimBuiltinRole(body.DefaultRole) {
				writeLegacy(w, opError(http.StatusBadRequest, "scim_default_role_invalid",
					"defaultRole must be viewer | editor | admin", nil))
				return
			}
			defaultRole = body.DefaultRole
		}
		if _, attached, err := s.getScimDirectoryForOrg(r.Context(), rc.orgID); err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		} else if attached {
			writeLegacy(w, opError(http.StatusConflict, "scim_directory_already_attached",
				"SCIM directory already attached for this org", nil))
			return
		}
		row, err := store.New(s.pool).InsertScimDirectory(r.Context(), store.InsertScimDirectoryParams{
			ID: s.newID(), OrgID: rc.orgID, ProviderDirectoryID: providerDirectoryID,
			DirectoryType: pgtype.Text{String: body.DirectoryType, Valid: body.DirectoryType != ""},
			DefaultRole:   defaultRole,
		})
		if err != nil {
			if isUniqueViolation(err) {
				writeLegacy(w, opError(http.StatusConflict, "scim_directory_already_attached",
					"SCIM directory already attached", nil))
				return
			}
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "org.scim.directory_attached", audit.Options{
			TargetType: "scim_directory", TargetID: row.ID,
			Metadata: map[string]any{
				"providerDirectoryId": providerDirectoryID,
				"directoryType":       textOrNull(row.DirectoryType), "defaultRole": defaultRole,
			},
		})
		writeLegacy(w, opOK(map[string]any{"directory": scimDirectoryView(row)}))
	}))

	mux.HandleFunc("POST /org/scim/directories/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct {
			DefaultRole *string `json:"defaultRole"`
			Status      *string `json:"status"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeLegacy(w, opError(http.StatusBadRequest, "scim_invalid_body", "invalid body", nil))
			return
		}
		if body.Status != nil {
			writeLegacy(w, opError(http.StatusBadRequest, "scim_directory_status_immutable",
				"use DELETE /org/scim/directories/{id} to revoke a directory", nil))
			return
		}
		if body.DefaultRole == nil {
			writeLegacy(w, opError(http.StatusBadRequest, "scim_no_updatable_fields",
				"no updatable fields provided", nil))
			return
		}
		if !isScimBuiltinRole(*body.DefaultRole) {
			writeLegacy(w, opError(http.StatusBadRequest, "scim_default_role_invalid",
				"defaultRole must be viewer | editor | admin", nil))
			return
		}
		row, err := store.New(s.pool).UpdateScimDirectoryDefaultRole(r.Context(), store.UpdateScimDirectoryDefaultRoleParams{
			ID: r.PathValue("id"), OrgID: rc.orgID, DefaultRole: *body.DefaultRole,
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusNotFound, "scim_directory_not_found", "SCIM directory not found", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "org.scim.directory_updated", audit.Options{
			TargetType: "scim_directory", TargetID: row.ID,
			Metadata: map[string]any{"defaultRole": *body.DefaultRole},
		})
		writeLegacy(w, opOK(map[string]any{"directory": scimDirectoryView(row)}))
	}))

	mux.HandleFunc("DELETE /org/scim/directories/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		rows, err := store.New(s.pool).RevokeScimDirectory(r.Context(), store.RevokeScimDirectoryParams{
			ID: r.PathValue("id"), OrgID: rc.orgID,
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		if rows == 0 {
			writeLegacy(w, opError(http.StatusNotFound, "scim_directory_not_found", "SCIM directory not found", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "org.scim.directory_revoked", audit.Options{
			TargetType: "scim_directory", TargetID: r.PathValue("id"),
		})
		writeLegacy(w, opOK(map[string]any{"ok": true}))
	}))

	// === Synced groups (read-only; backs the mapping picker) ===
	mux.HandleFunc("GET /org/scim/groups", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		directory, attached, err := s.getScimDirectoryForOrg(r.Context(), rc.orgID)
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		if !attached {
			writeLegacy(w, opOK(map[string]any{"groups": []map[string]any{}}))
			return
		}
		limit := scimGroupStateDefaultLimit
		if raw := r.URL.Query().Get("limit"); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
				limit = min(parsed, scimGroupStateMaxLimit)
			}
		}
		rows, err := store.New(s.pool).ListScimGroupState(r.Context(), store.ListScimGroupStateParams{
			OrgID: rc.orgID, ScimDirectoryID: directory.ID, Limit: int32(limit),
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		views := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			views = append(views, scimGroupView(row))
		}
		writeLegacy(w, opOK(map[string]any{"groups": views}))
	}))

	// === Admin CRUD on scim_group_role_mappings ===
	mux.HandleFunc("GET /org/scim/group-role-mappings", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		directory, attached, err := s.getScimDirectoryForOrg(r.Context(), rc.orgID)
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		views := []map[string]any{}
		if attached {
			rows, err := store.New(s.pool).ListScimGroupRoleMappings(r.Context(), store.ListScimGroupRoleMappingsParams{
				OrgID: rc.orgID, ScimDirectoryID: directory.ID,
			})
			if err != nil {
				writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
				return
			}
			for _, row := range rows {
				views = append(views, scimMappingView(row))
			}
		}
		writeLegacy(w, opOK(map[string]any{"mappings": views}))
	}))

	mux.HandleFunc("POST /org/scim/group-role-mappings", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct {
			ProviderGroupID string `json:"providerGroupId"`
			Role            string `json:"role"`
		}
		if err := decodeBody(r, &body); err != nil {
			writeLegacy(w, opError(http.StatusBadRequest, "scim_invalid_body", "invalid body", nil))
			return
		}
		directory, attached, err := s.getScimDirectoryForOrg(r.Context(), rc.orgID)
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		if !attached {
			writeLegacy(w, opError(http.StatusConflict, "scim_directory_required_for_mappings",
				"attach a SCIM directory before configuring group role mappings", nil))
			return
		}
		providerGroupID := strings.TrimSpace(body.ProviderGroupID)
		if providerGroupID == "" {
			writeLegacy(w, opError(http.StatusBadRequest, "scim_provider_group_id_required",
				"providerGroupId is required (e.g. directory_group_…)", nil))
			return
		}
		if !isScimBuiltinRole(body.Role) {
			writeLegacy(w, opError(http.StatusBadRequest, "scim_role_invalid",
				"role must be viewer | editor | admin", nil))
			return
		}
		q := store.New(s.pool)
		// The group must exist in synced state — guards typo'd /
		// cross-directory ids that would silently never match.
		if _, err := q.GetScimGroupState(r.Context(), store.GetScimGroupStateParams{
			ScimDirectoryID: directory.ID, ProviderGroupID: providerGroupID,
		}); err != nil {
			writeLegacy(w, opError(http.StatusNotFound, "scim_unknown_provider_group_id",
				"unknown providerGroupId for this directory", nil))
			return
		}
		if _, err := q.FindScimGroupRoleMappingByGroup(r.Context(), store.FindScimGroupRoleMappingByGroupParams{
			OrgID: rc.orgID, ScimDirectoryID: directory.ID, ProviderGroupID: providerGroupID,
		}); err == nil {
			writeLegacy(w, opError(http.StatusConflict, "scim_group_role_mapping_exists",
				"a mapping for this group already exists; update it instead", nil))
			return
		}
		row, err := q.InsertScimGroupRoleMapping(r.Context(), store.InsertScimGroupRoleMappingParams{
			ID: s.newID(), OrgID: rc.orgID, ScimDirectoryID: directory.ID,
			ProviderGroupID: providerGroupID, Role: body.Role,
			CreatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		})
		if err != nil {
			if isUniqueViolation(err) {
				writeLegacy(w, opError(http.StatusConflict, "scim_group_role_mapping_exists",
					"a mapping for this group already exists; update it instead", nil))
				return
			}
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "org.scim.group_role_mapping_created", audit.Options{
			TargetType: "scim_group_role_mapping", TargetID: row.ID,
			Metadata: map[string]any{
				"providerGroupId": providerGroupID, "role": body.Role, "scimDirectoryId": directory.ID,
			},
		})
		writeLegacy(w, opOK(map[string]any{"mapping": scimMappingView(row)}))
	}))

	mux.HandleFunc("POST /org/scim/group-role-mappings/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		var body struct {
			Role string `json:"role"`
		}
		if err := decodeBody(r, &body); err != nil || !isScimBuiltinRole(body.Role) {
			writeLegacy(w, opError(http.StatusBadRequest, "scim_role_invalid",
				"role must be viewer | editor | admin", nil))
			return
		}
		q := store.New(s.pool)
		existing, err := q.GetScimGroupRoleMappingByID(r.Context(), store.GetScimGroupRoleMappingByIDParams{
			ID: r.PathValue("id"), OrgID: rc.orgID,
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusNotFound, "scim_group_role_mapping_not_found",
				"group role mapping not found", nil))
			return
		}
		row, err := q.UpdateScimGroupRoleMappingRole(r.Context(), store.UpdateScimGroupRoleMappingRoleParams{
			ID: existing.ID, OrgID: rc.orgID, Role: body.Role,
			UpdatedBy: pgtype.Text{String: rc.userID, Valid: rc.userID != ""},
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusNotFound, "scim_group_role_mapping_not_found",
				"group role mapping not found", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "org.scim.group_role_mapping_updated", audit.Options{
			TargetType: "scim_group_role_mapping", TargetID: existing.ID,
			Metadata: map[string]any{
				"providerGroupId": existing.ProviderGroupID,
				"before":          existing.Role, "after": body.Role,
				"scimDirectoryId": existing.ScimDirectoryID,
			},
		})
		writeLegacy(w, opOK(map[string]any{"mapping": scimMappingView(row)}))
	}))

	mux.HandleFunc("DELETE /org/scim/group-role-mappings/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		q := store.New(s.pool)
		existing, err := q.GetScimGroupRoleMappingByID(r.Context(), store.GetScimGroupRoleMappingByIDParams{
			ID: r.PathValue("id"), OrgID: rc.orgID,
		})
		if err != nil {
			writeLegacy(w, opError(http.StatusNotFound, "scim_group_role_mapping_not_found",
				"group role mapping not found", nil))
			return
		}
		if _, err := q.DeleteScimGroupRoleMapping(r.Context(), store.DeleteScimGroupRoleMappingParams{
			ID: existing.ID, OrgID: rc.orgID,
		}); err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "org.scim.group_role_mapping_deleted", audit.Options{
			TargetType: "scim_group_role_mapping", TargetID: existing.ID,
			Metadata: map[string]any{
				"providerGroupId": existing.ProviderGroupID, "role": existing.Role,
				"scimDirectoryId": existing.ScimDirectoryID,
			},
		})
		writeLegacy(w, opOK(map[string]any{"ok": true}))
	}))

	// === Bulk role re-sync ===
	mux.HandleFunc("POST /org/scim/resync", s.auth(func(w http.ResponseWriter, r *http.Request, rc v1Request) {
		directory, attached, err := s.getScimDirectoryForOrg(r.Context(), rc.orgID)
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		if !attached {
			writeLegacy(w, opError(http.StatusConflict, "scim_directory_required_for_resync",
				"attach a SCIM directory before re-syncing roles", nil))
			return
		}
		result, err := s.resyncScimMemberRoles(r.Context(), directory)
		if err != nil {
			writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
			return
		}
		audit.Write(r.Context(), s.pool, rc.authContext, "org.scim.resynced", audit.Options{
			TargetType: "scim_directory", TargetID: directory.ID,
			Metadata: map[string]any{
				"membersResynced": result["membersResynced"], "membersChanged": result["membersChanged"],
				"skipped": result["skipped"], "capped": result["capped"], "scimDirectoryId": directory.ID,
			},
		})
		writeLegacy(w, opOK(result))
	}))

	// === Webhook receiver (public; signature-authorized) ===
	mux.HandleFunc("POST /webhooks/workos/directory", s.scimWebhookHandler)
}

/* --------------------------------- resync --------------------------------- */

// resyncScimMemberRoles applies the CURRENT group→role mappings to every
// active member of the directory on demand instead of waiting for each
// user's next inbound event. It reuses the SAME derivation the webhook
// handlers run — a re-sync only ever writes the role the next event would
// have produced. invited_by is deliberately NOT passed so the original
// provisioning actor survives. Per-member failures are isolated (skipped).
func (s *V1Server) resyncScimMemberRoles(ctx context.Context, directory store.ScimDirectory) (map[string]any, error) {
	q := store.New(s.pool)
	// Over-fetch cap+1 to distinguish a truncated sweep from one that
	// exactly fills the cap.
	fetched, err := q.ListActiveScimUserState(ctx, store.ListActiveScimUserStateParams{
		OrgID: directory.OrgID, ScimDirectoryID: directory.ID, Limit: scimResyncMaxMembers + 1,
	})
	if err != nil {
		return nil, err
	}
	mappings, err := s.scimGroupRoleMappingsMap(ctx, directory)
	if err != nil {
		return nil, err
	}
	capped := len(fetched) > scimResyncMaxMembers
	members := fetched
	if capped {
		members = fetched[:scimResyncMaxMembers]
	}
	resynced, changed, skipped := 0, 0, 0
	changes := []map[string]any{}
	for _, member := range members {
		lowerEmail := strings.ToLower(member.Email)
		groupIDs, err := q.ListScimUserGroupIDs(ctx, store.ListScimUserGroupIDsParams{
			OrgID: directory.OrgID, ScimDirectoryID: directory.ID, ProviderUserID: member.ProviderUserID,
		})
		if err != nil {
			skipped++
			continue
		}
		newRole := deriveScimRole(groupIDs, mappings, directory.DefaultRole)
		var currentRole any
		if row, err := q.FindScimMemberByEmail(ctx, store.FindScimMemberByEmailParams{
			OrgID: directory.OrgID, Email: pgtype.Text{String: lowerEmail, Valid: true},
		}); err == nil {
			currentRole = row.Role
		} else if !errors.Is(err, pgx.ErrNoRows) {
			skipped++
			continue
		}
		if err := s.upsertScimMembership(ctx, directory.OrgID, lowerEmail, newRole, ""); err != nil {
			skipped++
			continue
		}
		resynced++
		if currentRole != newRole {
			changed++
			changes = append(changes, map[string]any{
				"providerUserId": member.ProviderUserID, "email": lowerEmail,
				"from": currentRole, "to": newRole,
			})
		}
	}
	return map[string]any{
		"membersResynced": resynced, "membersChanged": changed,
		"skipped": skipped, "capped": capped, "changes": changes,
	}, nil
}

/* ------------------------------ webhook route ----------------------------- */

func (s *V1Server) scimWebhookHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rawBody, _ := io.ReadAll(io.LimitReader(r.Body, scimBodyMaxBytes))
	header := r.Header.Get("WorkOS-Signature")

	if valid, reason := verifyWorkOsSignature(header, string(rawBody), os.Getenv("WORKOS_WEBHOOK_SECRET"), time.Now()); !valid {
		// No org context yet — audit against the "default" tenant for
		// forensics, the reference's posture.
		s.scimAudit(ctx, "default", "scim.webhook.signature_invalid", "scim_event", "", map[string]any{
			"reason": reason,
		})
		writeLegacy(w, opError(http.StatusUnauthorized, "scim_invalid_signature", "invalid signature", nil))
		return
	}

	var parsed map[string]any
	if err := json.Unmarshal(rawBody, &parsed); err != nil {
		writeLegacy(w, opError(http.StatusBadRequest, "scim_invalid_json", "invalid JSON", nil))
		return
	}
	event := asScimEvent(parsed)
	if event == nil {
		writeLegacy(w, opError(http.StatusBadRequest, "scim_invalid_event_payload", "invalid event payload", nil))
		return
	}

	directoryID := extractScimDirectoryID(event)
	if directoryID == "" {
		s.scimAudit(ctx, "default", "scim.webhook.missing_directory_id", "scim_event", event.ID, map[string]any{
			"eventType": event.Event,
		})
		writeLegacy(w, opOK(map[string]any{"ok": true, "processed": false, "reason": "missing_directory_id"}))
		return
	}

	directory, err := store.New(s.pool).GetScimDirectoryByProviderDirectoryID(ctx, directoryID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Unknown directory — 200 so WorkOS stops retrying (it may
			// have been disconnected here with retries still pending).
			s.scimAudit(ctx, "default", "scim.webhook.unknown_directory", "scim_event", event.ID, map[string]any{
				"eventType": event.Event, "directoryId": directoryID,
			})
			writeLegacy(w, opOK(map[string]any{"ok": true, "processed": false, "reason": "unknown_directory"}))
			return
		}
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	if directory.Status == "revoked" {
		s.scimAudit(ctx, directory.OrgID, "scim.webhook.directory_revoked", "scim_event", event.ID, map[string]any{
			"eventType": event.Event, "scimDirectoryId": directory.ID,
		})
		writeLegacy(w, opOK(map[string]any{"ok": true, "processed": false, "reason": "directory_revoked"}))
		return
	}

	result, err := s.handleScimEvent(ctx, directory, event)
	if err != nil {
		writeLegacy(w, opError(http.StatusInternalServerError, "internal_error", "Internal error", nil))
		return
	}
	response := map[string]any{"ok": true, "processed": result.Processed}
	if result.Action != "" {
		response["action"] = result.Action
	}
	if result.Reason != "" {
		response["reason"] = result.Reason
	}
	writeLegacy(w, opOK(response))
}
