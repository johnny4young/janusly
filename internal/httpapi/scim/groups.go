// SCIM group handlers + shared membership write paths:
// group sync/delete, membership add/remove with role recompute, the
// (org_id, lower(email))-keyed upsert, and the domain-policy reader.
package scim

import (
	"context"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/johnny4young/janusly/internal/orgconfig"
	"github.com/johnny4young/janusly/internal/store"
)

/* ----------------------------- group handlers ----------------------------- */

// Membership events rely on the top-level event-id replay guard plus the
// idempotent scim_user_groups join (ON CONFLICT DO NOTHING); they carry NO
// per-membership out-of-order guard — the join table has no timestamp, so
// the derived role reflects whatever join rows exist (eventual
// consistency). A reordered add/remove pair leaves a stale role one rank
// off until the next membership event corrects it; it can never escalate
// beyond an admin-configured mapping. Accepted v1 posture (reference).

func (s *Service) scimGroupUpsert(ctx context.Context, directory store.ScimDirectory, event *scimEvent) (scimResult, error) {
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

func (s *Service) scimGroupDeleted(ctx context.Context, directory store.ScimDirectory, event *scimEvent) (scimResult, error) {
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

func (s *Service) scimGroupUserAdded(ctx context.Context, directory store.ScimDirectory, event *scimEvent) (scimResult, error) {
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

func (s *Service) scimGroupUserRemoved(ctx context.Context, directory store.ScimDirectory, event *scimEvent) (scimResult, error) {
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

func (s *Service) upsertScimUserState(ctx context.Context, directory store.ScimDirectory, providerUserID, lowerEmail string, event *scimEvent, eventTimestamp time.Time) error {
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
func (s *Service) resolveDerivedScimRole(ctx context.Context, directory store.ScimDirectory, providerUserID string) (string, error) {
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

func (s *Service) scimGroupRoleMappingsMap(ctx context.Context, directory store.ScimDirectory) (map[string]string, error) {
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
func (s *Service) recomputeScimMemberRole(ctx context.Context, directory store.ScimDirectory, event *scimEvent, providerUserID, providerGroupID, change string) error {
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
func (s *Service) upsertScimMembership(ctx context.Context, orgID, lowerEmail, role, invitedBy string) error {
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
	for entry := range strings.SplitSeq(raw, ",") {
		if trimmed := strings.ToLower(strings.TrimSpace(entry)); trimmed != "" {
			domains = append(domains, trimmed)
		}
	}
	return domains
}

func containsString(values []string, want string) bool {
	return slices.Contains(values, want)
}
