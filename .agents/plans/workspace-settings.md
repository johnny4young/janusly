# Workspace Settings Backlog

Internal planning notes for future implementation. Keep this out of
release-facing documentation.

## Product Goal

Give workspace admins a professional settings area where tenant runtime choices
are understandable, auditable, and safe to edit without redeploying Janusly.

## Constraints

- `org_configs` remains tenant runtime settings only.
- No secrets, tokens, API keys, database URLs, Redis URLs, Supabase keys,
  service tokens, arbitrary env vars, authorization headers, cookies, private
  keys, or workflow secret values in `org_configs`.
- Reject string values that look like credentials even when the config key is
  otherwise allowed.
- Secret values stay in env/vault-backed `credentials.secret_ref`.
- UI labels should be user-facing and non-technical; raw config keys can appear
  only in developer-oriented detail views.
- Every mutation must go through API RBAC and audit logging.

## Tickets

### WSS-001 — Workspace Settings Shell

Build a settings view with clear sections for AI, execution policy, outbound
HTTP safety, connections, team, billing/usage, and audit history.

Acceptance criteria:

- Admin-only navigation entry.
- Non-admin users see read-only state or a permission message.
- Settings sections use existing design tokens and `lucide-react` icons.
- Responsive layout works from mobile to desktop without nested cards.

### WSS-002 — Tenant Runtime Config UI

Expose `GET /org/config` as editable controls for the safe catalog only.

Acceptance criteria:

- Provider is a segmented/select control, not a raw text field.
- Models are text inputs with helper text explaining fallback behavior.
- Numeric values use bounded number inputs.
- Boolean policies use switches/checkboxes.
- Each row shows whether the value comes from default, env, or tenant override.
- Save calls `POST /org/config`, bumps platform version, and shows audit-safe copy.

### WSS-003 — AI Readiness Panel

Make “full AI” readiness understandable without leaking secrets.

Acceptance criteria:

- Shows active provider/model from tenant runtime config.
- Shows whether provider credentials are present without exposing values.
- Explains fallback mode in plain language.
- Links missing-key setup to configuration docs.
- Includes a test prompt action for admins that validates live AI mode.

### WSS-004 — Config Change Audit View

Surface tenant config changes as part of workspace administration.

Acceptance criteria:

- Filter audit logs by `resourceType=org_config`.
- Show key, previous/current source when available, actor, and timestamp.
- Do not show secret-like values; current catalog should not contain them, but
  renderer still applies defensive redaction.

### WSS-005 — Runtime Config Cache

Avoid repeated DB reads for hot execution paths.

Acceptance criteria:

- Cache config snapshots per `orgId` with a short TTL.
- Invalidate on successful `POST /org/config`.
- Preserve deterministic fallback to env/defaults on cache miss.
- Add tests for cache invalidation and stale-value avoidance.

### WSS-006 — Workspace Settings E2E

Add browser coverage for the settings workflows.

Acceptance criteria:

- Admin can load settings, update a safe config value, and see the new source.
- Viewer cannot mutate settings.
- AI readiness displays fallback when provider key is absent.
- Mobile viewport keeps forms readable and buttons separated from inputs.

### WSS-007 — API Contract Tests

Lock the safety boundary around `org_configs`.

Acceptance criteria:

- Unknown keys are rejected.
- Credential-looking keys are impossible to register in the catalog.
- Credential-looking env fallbacks are impossible to register in the catalog.
- Values with the wrong type are rejected.
- Writes create audit rows and preserve org scope.
