-- SCIM directory sync (WorkOS): directorios, estado, mapeos, dedupe.

-- name: GetScimDirectoryByOrgID :one
SELECT * FROM scim_directories WHERE org_id = $1;

-- name: GetScimDirectoryByID :one
SELECT * FROM scim_directories WHERE id = $1 AND org_id = $2;

-- The webhook's org-binding seam: deliberately un-scoped — the inbound
-- event carries no tenant, so the matched row IS the tenant grant.
-- name: GetScimDirectoryByProviderDirectoryID :one
SELECT * FROM scim_directories WHERE provider_directory_id = $1;

-- name: ListScimDirectories :many
SELECT * FROM scim_directories WHERE org_id = $1 ORDER BY created_at ASC;

-- name: InsertScimDirectory :one
INSERT INTO scim_directories (id, org_id, provider_directory_id, directory_type, default_role)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: UpdateScimDirectoryDefaultRole :one
UPDATE scim_directories SET default_role = $3, updated_at = now()
WHERE id = $1 AND org_id = $2
RETURNING *;

-- Revoke is a HARD delete (reference revokeScimDirectory): the unique
-- (org_id) and (provider_directory_id) indexes must free up so a re-attach
-- can succeed; orphaned state/mapping rows are tolerated (no FK) and the
-- create-path collision guard absorbs SCIM-owned memberships on re-provision.
-- name: RevokeScimDirectory :execrows
DELETE FROM scim_directories WHERE id = $1 AND org_id = $2;

-- name: RecordScimDirectorySync :exec
UPDATE scim_directories SET last_synced_at = now(), updated_at = now()
WHERE id = $1 AND org_id = $2;

-- Replay guard: 1 row inserted = fresh claim; 0 = already processed.
-- name: RecordScimProcessedEvent :execrows
INSERT INTO scim_processed_events (event_id, org_id, scim_directory_id, event_type)
VALUES ($1, $2, $3, $4)
ON CONFLICT (event_id) DO NOTHING;

-- name: DeleteScimProcessedEvent :exec
DELETE FROM scim_processed_events WHERE event_id = $1 AND org_id = $2;

-- name: GetScimUserState :one
SELECT * FROM scim_user_state WHERE scim_directory_id = $1 AND provider_user_id = $2;

-- name: UpsertScimUserState :exec
INSERT INTO scim_user_state (id, org_id, scim_directory_id, provider_user_id, email,
  first_name, last_name, active, last_event_id, last_event_timestamp)
VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9)
ON CONFLICT (scim_directory_id, provider_user_id) DO UPDATE SET
  email = excluded.email, first_name = excluded.first_name, last_name = excluded.last_name,
  active = true, last_event_id = excluded.last_event_id,
  last_event_timestamp = excluded.last_event_timestamp, updated_at = now();

-- name: MarkScimUserInactive :exec
UPDATE scim_user_state SET active = false, last_event_id = $2, last_event_timestamp = $3, updated_at = now()
WHERE id = $1;

-- name: ListActiveScimUserState :many
SELECT provider_user_id, email FROM scim_user_state
WHERE org_id = $1 AND scim_directory_id = $2 AND active = true
ORDER BY email ASC
LIMIT $3;

-- name: GetScimGroupState :one
SELECT * FROM scim_group_state WHERE scim_directory_id = $1 AND provider_group_id = $2;

-- name: UpsertScimGroupState :exec
INSERT INTO scim_group_state (id, org_id, scim_directory_id, provider_group_id, name)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (scim_directory_id, provider_group_id) DO UPDATE SET
  name = excluded.name, last_synced_at = now();

-- name: DeleteScimGroupState :exec
DELETE FROM scim_group_state WHERE id = $1;

-- name: ListScimGroupState :many
SELECT * FROM scim_group_state WHERE org_id = $1 AND scim_directory_id = $2
ORDER BY name ASC
LIMIT $3;

-- name: ListScimGroupRoleMappings :many
SELECT * FROM scim_group_role_mappings WHERE org_id = $1 AND scim_directory_id = $2
ORDER BY created_at ASC;

-- name: GetScimGroupRoleMappingByID :one
SELECT * FROM scim_group_role_mappings WHERE id = $1 AND org_id = $2;

-- name: FindScimGroupRoleMappingByGroup :one
SELECT * FROM scim_group_role_mappings
WHERE org_id = $1 AND scim_directory_id = $2 AND provider_group_id = $3;

-- name: InsertScimGroupRoleMapping :one
INSERT INTO scim_group_role_mappings (id, org_id, scim_directory_id, provider_group_id, role, created_by)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: UpdateScimGroupRoleMappingRole :one
UPDATE scim_group_role_mappings SET role = $3, updated_by = $4, updated_at = now()
WHERE id = $1 AND org_id = $2
RETURNING *;

-- name: DeleteScimGroupRoleMapping :execrows
DELETE FROM scim_group_role_mappings WHERE id = $1 AND org_id = $2;

-- name: ListScimUserGroupIDs :many
SELECT provider_group_id FROM scim_user_groups
WHERE org_id = $1 AND scim_directory_id = $2 AND provider_user_id = $3;

-- name: ListScimUserIDsForGroup :many
SELECT provider_user_id FROM scim_user_groups
WHERE org_id = $1 AND scim_directory_id = $2 AND provider_group_id = $3;

-- name: AddScimUserGroup :exec
INSERT INTO scim_user_groups (id, org_id, scim_directory_id, provider_user_id, provider_group_id)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (scim_directory_id, provider_user_id, provider_group_id) DO NOTHING;

-- name: RemoveScimUserGroup :exec
DELETE FROM scim_user_groups
WHERE org_id = $1 AND scim_directory_id = $2 AND provider_user_id = $3 AND provider_group_id = $4;

-- name: DeleteScimUserGroupsForUser :exec
DELETE FROM scim_user_groups
WHERE org_id = $1 AND scim_directory_id = $2 AND provider_user_id = $3;

-- name: DeleteScimUserGroupsForGroup :exec
DELETE FROM scim_user_groups
WHERE org_id = $1 AND scim_directory_id = $2 AND provider_group_id = $3;

-- SCIM membership writes are keyed on (org_id, lower(email)) — the
-- user-stable join key — not (org_id, user_id); see the reference's
-- upsertMembershipByEmail. The update preserves invited_by (and user_id,
-- which the SSO backfill may have rewritten) unless a new inviter is given.
-- The lookup matches the email COLUMN or an email-shaped user_id: the
-- legacy pre-invite rows seed userId with the email and leave the email
-- column NULL (the auth resolver's backfill acknowledges them) — without
-- this arm the collision guard is blind to them and provisioning 500s
-- on the (org_id, user_id) unique index forever (T-534 property find).
-- name: FindScimMemberByEmail :one
SELECT id, user_id, role, invited_by FROM org_members
WHERE org_id = $1 AND (email = $2 OR lower(user_id) = $2);

-- name: UpdateScimMembershipByEmail :execrows
UPDATE org_members SET email = sqlc.arg(email), role = sqlc.arg(role),
  invited_by = coalesce(sqlc.narg(invited_by), invited_by)
WHERE id = sqlc.arg(id) AND org_id = sqlc.arg(org_id);

-- name: InsertScimMembership :exec
INSERT INTO org_members (id, org_id, user_id, email, role, invited_by)
VALUES (sqlc.arg(id), sqlc.arg(org_id), sqlc.arg(email), sqlc.arg(email), sqlc.arg(role), sqlc.narg(invited_by));

-- Deprovisioning only ever deletes rows SCIM itself created — a
-- human-invited row sharing the email must survive a directory delete
-- (T-534 property find: the unguarded delete could remove the human).
-- name: DeleteScimMembershipByEmail :execrows
DELETE FROM org_members
WHERE org_id = $1 AND email = $2 AND invited_by = sqlc.arg(invited_by);
