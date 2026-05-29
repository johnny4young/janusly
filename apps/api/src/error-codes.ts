/**
 * Closed catalog of stable API error codes that the web client translates
 * via `apiErrors.<code>` in its i18n catalog. The server stays
 * locale-blind for error responses — it ships
 * `{ error: "<EN fallback>", code: "<snake_code>", params?: {...} }`
 * and the web's `tApiError` helper translates against the catalog,
 * falling back to the literal `error` string when the code is missing.
 *
 * v1 covers the highest-impact 4xx envelopes that surface as toast
 * notifications in the migrated UI panels (members, roles, mcp,
 * dlq, workflows). The remaining ~150 lower-traffic envelopes stay
 * free-form English in v1 — they're picked up in a future pass when
 * product priority demands it.
 *
 * Adding a new code is three edits:
 *   1. New entry in the `ApiErrorCode` union below.
 *   2. EN string in `apps/web/src/i18n/locales/en/common.json`
 *      under `apiErrors.<code>`.
 *   3. ES string in `apps/web/src/i18n/locales/es/common.json` under
 *      the same key. (The parity test catches any mismatch.)
 *
 * Used by:
 * - `apps/api/src/routes/*` — each migrated 4xx response builds its
 *   envelope through `errorEnvelope`.
 * - `apps/web/src/i18n/server-events.ts:tApiError` — the client-side
 *   translator that resolves `apiErrors.<code>` from the catalog.
 */

/**
 * Closed union of stable error codes. Snake_case, lowercased, no
 * prefix. Mirrors the `apiErrors.*` namespace in the web catalog.
 */
export type ApiErrorCode =
  // members
  | "email_required"
  | "email_invalid"
  | "invitation_pending_exists"
  | "member_exists"
  | "member_not_found"
  | "self_membership_modification"
  // roles
  | "role_in_use"
  | "role_already_exists"
  | "role_not_found"
  // mcp
  | "mcp_connection_not_found"
  | "mcp_tool_not_found"
  | "mcp_connection_duplicate"
  // dlq
  | "dlq_not_found"
  | "dlq_field_required"
  // workflows
  | "workflow_not_found"
  | "workflow_name_required"
  // credentials
  | "credential_rotation_conflict";

/**
 * Canonical 4xx response envelope. The `error` field is the English
 * fallback the server ships for curl / CI / non-web clients; the
 * `code` field is the stable translation key the web reads first.
 * `params` carries structured interpolation values (member email, role
 * name, member count, etc.) that the catalog template references via
 * i18next `{{var}}` syntax.
 */
export type ApiErrorEnvelope = {
  error: string;
  code: ApiErrorCode;
  params?: Record<string, string | number | boolean>;
};

/**
 * Build the canonical envelope. Inline use:
 *
 *   return sendJson(res, errorEnvelope("member_exists", "Member already exists for this org", { email }), 409);
 *
 * The `message` argument is the EN fallback — clients without a
 * catalog entry render it verbatim.
 */
export function errorEnvelope(
  code: ApiErrorCode,
  message: string,
  params?: Record<string, string | number | boolean>,
): ApiErrorEnvelope {
  return params === undefined ? { error: message, code } : { error: message, code, params };
}
