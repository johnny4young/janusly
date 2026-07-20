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
  | "upstream_degraded"
  | "workflow_circuit_breaker_paused"
  | "workflow_not_circuit_breaker_paused"
  // upstream health sources
  | "upstream_source_not_found"
  | "upstream_source_duplicate"
  // credentials
  | "credential_rotation_conflict"
  | "credential_expiry_conflict"
  // snippets
  | "snippet_not_found"
  | "snippet_name_exists"
  | "snippet_builtin_immutable"
  // eval datasets
  | "eval_dataset_not_found"
  | "eval_dataset_name_exists"
  | "eval_dataset_name_required"
  // experiments
  | "experiment_invalid_body"
  | "experiment_dataset_not_found"
  | "experiment_dataset_empty"
  | "experiment_prompt_ref_invalid"
  | "experiment_not_found"
  // inbound trigger events
  | "trigger_invalid_payload"
  | "trigger_payload_too_large"
  | "trigger_no_matching_node"
  | "trigger_dkim_required"
  | "trigger_event_not_found"
  // solution packs
  | "pack_not_found"
  | "pack_missing_sample_payload"
  | "pack_no_failure_fixture"
  // onboarding
  | "onboarding_invalid_action"
  // ai
  | "ai_dead_letter_id_required"
  | "ai_prompt_too_long"
  | "ai_question_too_long"
  | "ai_run_id_required"
  | "ai_run_not_found"
  // alerts
  | "alerts_policy_id_required"
  | "alerts_policy_invalid"
  | "alerts_policy_not_found"
  | "alerts_policy_refinement_failed"
  | "alerts_policy_system_trigger_only"
  // auto-healing
  | "autoheal_apply_replay_failed"
  | "autoheal_dlq_or_node_missing"
  | "autoheal_invalid_body"
  | "autoheal_missing_id"
  | "autoheal_not_found"
  | "autoheal_patch_revalidation_failed"
  | "autoheal_rate_limited"
  | "autoheal_not_pending"
  | "autoheal_already_resolved"
  // billing
  | "billing_monthly_usd_invalid"
  | "billing_policy_invalid"
  | "billing_unknown_breakdown_dimension"
  | "billing_warn_percent_invalid"
  | "billing_workflow_id_required"
  // credentials
  | "credentials_fields_required"
  | "credentials_invalid_expiry"
  | "credentials_expiry_required"
  | "credentials_expiry_failed"
  | "credentials_if_match_invalid"
  | "credentials_if_match_required"
  | "credentials_invalid_secret_ref"
  | "credentials_name_required"
  | "credentials_not_found"
  | "credentials_rotation_failed"
  // dlq
  | "dlq_failing_node_missing"
  | "dlq_fields_required"
  | "dlq_forbidden"
  | "dlq_ids_cap_exceeded"
  | "dlq_ids_invalid_entries"
  | "dlq_ids_required"
  | "dlq_invalid_severity"
  | "dlq_invalid_sort"
  | "dlq_invalid_status"
  | "dlq_node_not_found"
  | "dlq_replay_conflict"
  | "dlq_node_mid_retry"
  | "dlq_workflow_sanitize_failed"
  | "dlq_workflow_schema_invalid"
  | "dlq_workflow_version_not_found"
  // eval datasets
  | "eval_dataset_id_required"
  | "eval_dataset_unknown_format"
  // experiments
  | "experiments_id_required"
  // generic
  | "invalid_input"
  | "not_found"
  // mcp
  | "mcp_alias_invalid"
  | "mcp_alias_required"
  | "mcp_alias_tool_required"
  | "mcp_command_allowlist_empty"
  | "mcp_command_invalid"
  | "mcp_command_not_allowed"
  | "mcp_command_required"
  | "mcp_process_disabled"
  | "mcp_no_updatable_fields"
  | "mcp_rate_limit_invalid"
  | "mcp_rate_limited"
  | "mcp_transport_invalid"
  | "mcp_tenant_disabled"
  | "mcp_url_invalid"
  | "mcp_url_required"
  // members
  | "members_invitation_id_required"
  | "members_invitation_not_found"
  | "members_role_not_defined"
  | "members_user_id_required"
  // replay / fork
  | "nested_replay_lab"
  | "no_workflow_snapshot"
  | "invalid_snapshot"
  | "override_too_large"
  | "fork_node_not_found"
  | "predecessor_not_succeeded"
  // org config
  | "org_config_invalid"
  | "org_key_required"
  | "org_value_required"
  // plugins
  | "plugins_plugin_id_required"
  // prompts
  | "prompts_description_too_long"
  | "prompts_invalid_url"
  | "prompts_name_duplicate"
  | "prompts_name_invalid"
  | "prompts_not_found"
  | "prompts_template_required"
  | "prompts_template_too_long"
  | "prompts_variables_invalid"
  | "prompts_version_invalid"
  | "prompts_version_not_found"
  // recovery
  | "recovery_evidence_invalid_body"
  | "recovery_evidence_rate_limited"
  | "recovery_evidence_unknown_format"
  | "recovery_feedback_saved_only"
  | "recovery_handoff_invalid"
  | "recovery_id_required"
  | "recovery_invalid_feedback_body"
  | "recovery_invalid_filter"
  | "recovery_item_not_found"
  | "recovery_item_transition_invalid"
  | "recovery_item_not_escalation"
  | "recovery_item_comment_cap_reached"
  | "recovery_playbook_acceptance_required"
  | "recovery_playbook_apply_required"
  | "recovery_playbook_evidence_required"
  | "recovery_playbook_invalid_body"
  | "recovery_playbook_invalid_status"
  | "recovery_playbook_match_changed"
  | "recovery_playbook_not_found"
  | "recovery_playbook_outcome_invalid"
  | "recovery_playbook_source_invalid"
  | "recovery_playbook_source_mismatch"
  | "recovery_playbook_validation_required"
  // reports
  | "reports_invalid_request"
  | "reports_rate_limit_exceeded"
  | "reports_run_id_required"
  | "reports_run_not_found"
  | "reports_unknown_format"
  // roles
  | "roles_builtin_name"
  | "roles_inherits_immutable"
  | "roles_inherits_invalid"
  | "roles_name_invalid"
  | "roles_name_required"
  | "roles_no_updatable_fields"
  | "roles_override_not_found"
  | "roles_permissions_invalid"
  // runs
  | "runs_adhoc_disabled"
  | "runs_already_terminal"
  | "runs_base_and_replay_run_id_required"
  | "runs_compare_run_not_found"
  | "runs_forbidden"
  | "runs_input_validation_failed"
  | "runs_invalid_resume_token"
  | "runs_no_decision_event"
  | "runs_not_production_ready"
  | "runs_redrive_source_not_failed"
  | "runs_redrive_node_not_failed"
  | "runs_redrive_node_ambiguous"
  | "runs_redrive_requires_saved_workflow"
  | "runs_redrive_workflow_paused"
  | "runs_redrive_version_not_found"
  | "runs_redrive_version_invalid"
  | "runs_redrive_node_missing_in_version"
  | "runs_redrive_predecessor_not_succeeded"
  | "runs_resume_conflict"
  | "runs_resume_token_required"
  | "runs_run_id_event_id_and_node_id_required"
  | "runs_run_id_and_node_id_required"
  | "runs_run_id_required"
  | "runs_run_not_found"
  | "runs_source_run_id_required"
  | "runs_source_run_not_found"
  | "runs_suggested_workflow_not_object"
  | "runs_suggested_workflow_sanitize_failed"
  | "runs_suggested_workflow_invalid"
  | "runs_validation_failed"
  // scim
  | "scim_default_role_invalid"
  | "scim_directory_already_attached"
  | "scim_directory_id_required"
  | "scim_directory_not_found"
  | "scim_directory_required_for_mappings"
  | "scim_directory_required_for_resync"
  | "scim_directory_status_immutable"
  | "scim_group_role_mapping_exists"
  | "scim_group_role_mapping_not_found"
  | "scim_invalid_event_payload"
  | "scim_invalid_json"
  | "scim_invalid_signature"
  | "scim_mapping_id_required"
  | "scim_no_updatable_fields"
  | "scim_provider_directory_id_required"
  | "scim_provider_group_id_required"
  | "scim_role_invalid"
  | "scim_unknown_provider_group_id"
  // server
  | "server_internal_error"
  | "server_not_found"
  | "server_request_failed"
  // snippets
  | "snippet_id_required"
  // sso
  | "sso_callback_not_configured"
  | "sso_code_and_state_required"
  | "sso_connection_exists"
  | "sso_connection_id_required"
  | "sso_connection_mismatch"
  | "sso_connection_not_found"
  | "sso_exchange_failed"
  | "sso_invalid_state"
  | "sso_membership_persist_failed"
  | "sso_no_active_connection"
  | "sso_no_updatable_fields"
  | "sso_not_configured"
  | "sso_org_id_required"
  | "sso_provider_connection_id_invalid"
  | "sso_provider_connection_id_required"
  | "sso_provider_invalid"
  | "sso_policy_violation"
  // streaming
  | "stream_cap_exceeded"
  | "stream_unavailable"
  // upstream health sources
  | "upstream_source_id_required"
  // workflow metadata
  | "workflow_metadata_invalid"
  | "workflow_metadata_workflow_id_required"
  // workflows
  | "workflows_after_version_invalid"
  | "workflows_no_versions"
  | "workflows_rollback_conflict"
  | "workflows_rollback_ids_required"
  | "workflows_save_conflict"
  | "workflows_source_version_not_found"
  | "workflows_upstream_health_sources_invalid"
  | "workflows_validation_failed"
  | "workflows_version_malformed"
  | "workflows_workflow_id_required";

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

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build the canonical envelope. Inline use:
 *
 *   return sendJson(res, errorEnvelope("member_exists", "Member already exists for this org", { email }), 409);
 *
 * The `message` argument is the EN fallback for clients without a catalog
 * entry. When `params` are supplied, `{{key}}` placeholders in `message` are
 * interpolated from `params` — mirroring how the web renders the localized
 * `apiErrors.<code>` template — so the fallback is a fully-rendered English
 * string instead of raw `{{key}}` braces, while `params` still travels for
 * localization. Only keys present in `params` are substituted; any unmatched
 * placeholder is left untouched.
 */
export function errorEnvelope(
  code: ApiErrorCode,
  message: string,
  params?: Record<string, string | number | boolean>,
): ApiErrorEnvelope {
  if (params === undefined) return { error: message, code };
  let error = message;
  for (const [key, value] of Object.entries(params)) {
    error = error.replace(new RegExp(`\\{\\{\\s*${escapeRegExp(key)}\\s*\\}\\}`, "g"), String(value));
  }
  return { error, code, params };
}
