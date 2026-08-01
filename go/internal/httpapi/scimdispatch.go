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
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/go/internal/audit"
	"github.com/johnny4young/janusly/go/internal/store"
)

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
