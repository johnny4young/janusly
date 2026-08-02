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

-- Identity surfaces (T-519): the caller's memberships with org names,
-- profile upsert, the invitation-accept CAS, and the plugin stub row.

-- name: ListUserMemberships :many
SELECT m.org_id, m.role, coalesce(o.name, m.org_id) AS organization_name, o.plan
FROM org_members m
LEFT JOIN organizations o ON o.id = m.org_id
WHERE m.user_id = $1
ORDER BY m.org_id
LIMIT 50;

-- Identity bootstrap uses one extra row to report truncation without an
-- unbounded count. The LEFT JOIN preserves orphan-tolerant membership truth.
-- name: ListIdentityMemberships :many
SELECT m.org_id, m.role, o.name AS organization_name, o.plan AS organization_plan
FROM org_members m
LEFT JOIN organizations o ON o.id = m.org_id
WHERE m.user_id = $1
ORDER BY o.name, m.org_id
LIMIT 201;

-- name: GetUserProfile :one
SELECT id, name, email FROM users WHERE id = $1;

-- name: ListIdentityInvitations :many
SELECT i.id, i.org_id, i.role, o.name AS organization_name
FROM invitations i
LEFT JOIN organizations o ON o.id = i.org_id
WHERE lower(i.email) = lower(sqlc.arg(email)::text) AND i.status = 'pending'
ORDER BY i.created_at, i.id
LIMIT 51;

-- name: UpsertUserProfile :one
INSERT INTO users (id, name, email)
VALUES ($1, $2, $3)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    email = coalesce(EXCLUDED.email, users.email),
    updated_at = now()
RETURNING id, name, email;

-- Bootstrap profile upserts never erase an existing name/email merely because
-- the current provider omitted that optional claim.
-- name: UpsertIdentityProfile :one
INSERT INTO users (id, name, email, updated_at)
VALUES ($1, $2, $3, now())
ON CONFLICT (id) DO UPDATE
SET name = coalesce(EXCLUDED.name, users.name),
    email = coalesce(EXCLUDED.email, users.email),
    updated_at = now()
RETURNING id, name, email;

-- name: InsertIdentityOrganization :exec
INSERT INTO organizations (id, name, plan)
VALUES ($1, $2, 'free');

-- Founder membership is a strict insert: the organization id is new inside
-- the same transaction, so a conflict is a real invariant violation.
-- name: InsertFounderMembership :exec
INSERT INTO org_members (id, org_id, user_id, email, role, invited_by)
VALUES ($1, $2, $3, $4, 'admin', NULL);

-- name: LockPendingIdentityInvitation :one
SELECT id, org_id, email, role, invited_by
FROM invitations
WHERE id = $1
  AND lower(email) = lower(sqlc.arg(email)::text)
  AND status = 'pending'
FOR UPDATE;

-- name: MarkIdentityInvitationAccepted :execrows
UPDATE invitations
SET status = 'accepted', accepted_at = now()
WHERE id = $1 AND status = 'pending';

-- The verified provider id is the durable membership key. Re-acceptance of a
-- newly issued invitation for the same org updates the existing grant exactly
-- like the Node oracle.
-- name: UpsertInvitedIdentityMembership :exec
INSERT INTO org_members (id, org_id, user_id, email, role, invited_by)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (org_id, user_id) DO UPDATE
SET email = EXCLUDED.email,
    role = EXCLUDED.role,
    invited_by = EXCLUDED.invited_by;

-- name: InsertOrgMember :execrows
INSERT INTO org_members (id, org_id, user_id, role)
VALUES ($1, $2, $3, $4)
ON CONFLICT DO NOTHING;

-- name: GetInvitationByID :one
SELECT id, org_id, email, role, status FROM invitations WHERE id = $1;

-- The accept CAS: only a still-pending row flips, exactly once.
-- name: AcceptInvitation :execrows
UPDATE invitations SET status = 'accepted', accepted_at = now()
WHERE id = $1 AND status = 'pending';

-- name: InsertInstalledPlugin :exec
INSERT INTO installed_plugins (id, org_id, plugin_id, config_json, installed_by)
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
