-- Membership, invitations, roles, permission overrides.

-- name: GetOrgMembership :one
SELECT id, org_id, user_id, role FROM org_members
WHERE org_id = $1 AND user_id = $2;

-- name: ListOrgMembershipsForUser :many
SELECT id, org_id, user_id, role FROM org_members
WHERE user_id = $1
ORDER BY created_at, id;

-- Legacy-orphan lazy backfill: rows seeded with userId = email before
-- invite-acceptance shipped migrate to the real provider UUID on first
-- authenticated sign-in.
-- name: FindOrgMemberByEmail :one
SELECT id, org_id, user_id, role FROM org_members
WHERE org_id = $1 AND lower(email) = lower($2);

-- name: MigrateOrgMemberUserID :execrows
UPDATE org_members SET user_id = $3
WHERE id = $1 AND org_id = $2;

-- name: GetOrgRole :one
SELECT id, org_id, name, inherits_from, description, is_builtin, granted_permissions
FROM org_roles
WHERE org_id = $1 AND name = $2;

-- name: ListOrgMembers :many
SELECT id, org_id, user_id, email, role, invited_by, created_at
FROM org_members WHERE org_id = $1
ORDER BY created_at, id;

-- name: UpdateOrgMemberRole :execrows
UPDATE org_members SET role = $3
WHERE org_id = $1 AND user_id = $2;

-- name: DeleteOrgMember :execrows
DELETE FROM org_members WHERE org_id = $1 AND user_id = $2;

-- name: FindOrgMemberRowByEmail :one
SELECT id FROM org_members WHERE org_id = $1 AND email = $2;

-- name: ListOrgInvitations :many
SELECT id, org_id, email, role, invited_by, status, accepted_at, created_at
FROM invitations WHERE org_id = $1
ORDER BY created_at DESC, id;

-- name: FindPendingInvitation :one
SELECT id FROM invitations
WHERE org_id = $1 AND email = $2 AND status = 'pending';

-- name: InsertInvitation :exec
INSERT INTO invitations (id, org_id, email, role, invited_by)
VALUES ($1, $2, $3, $4, $5);

-- name: RevokePendingInvitation :execrows
UPDATE invitations SET status = 'revoked'
WHERE id = $1 AND org_id = $2 AND status = 'pending';

-- name: ListOrgRoles :many
SELECT id, org_id, name, inherits_from, description, is_builtin, granted_permissions
FROM org_roles WHERE org_id = $1
ORDER BY name;

-- name: InsertOrgRole :exec
INSERT INTO org_roles (id, org_id, name, inherits_from, description, is_builtin, granted_permissions)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: UpdateOrgRole :one
UPDATE org_roles
SET granted_permissions = COALESCE(sqlc.narg(granted_permissions), granted_permissions),
    description = COALESCE(sqlc.narg(description), description),
    inherits_from = COALESCE(sqlc.narg(inherits_from), inherits_from)
WHERE org_id = $1 AND name = $2
RETURNING id, org_id, name, inherits_from, description, is_builtin, granted_permissions;

-- name: DeleteOrgRole :execrows
DELETE FROM org_roles WHERE org_id = $1 AND name = $2;

-- name: CountMembersInRole :one
SELECT count(*)::int FROM org_members WHERE org_id = $1 AND role = $2;
