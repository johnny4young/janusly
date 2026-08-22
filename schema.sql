--
-- PostgreSQL database dump
--


-- Dumped from database version 18.4 (Debian 18.4-1.pgdg12+1)
-- Dumped by pg_dump version 18.4 (Debian 18.4-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: alert_dispatches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_dispatches (
    id text NOT NULL,
    org_id text NOT NULL,
    policy_id text NOT NULL,
    dedupe_key text NOT NULL,
    dispatched_at timestamp with time zone DEFAULT now() NOT NULL,
    outcome text NOT NULL,
    channel_results jsonb NOT NULL,
    trigger_payload jsonb NOT NULL
);


--
-- Name: alert_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alert_policies (
    id text NOT NULL,
    org_id text NOT NULL,
    name text NOT NULL,
    trigger text NOT NULL,
    parameters jsonb DEFAULT '{}'::jsonb NOT NULL,
    channels jsonb NOT NULL,
    cooldown_seconds integer DEFAULT 900 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id text NOT NULL,
    org_id text NOT NULL,
    user_id text,
    action text NOT NULL,
    target_type text,
    target_id text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now(),
    hold_until timestamp with time zone
);


--
-- Name: auth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_sessions (
    id text NOT NULL,
    user_id text NOT NULL,
    email text NOT NULL,
    org_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: auto_healing_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auto_healing_runs (
    id text NOT NULL,
    org_id text NOT NULL,
    dead_letter_id text NOT NULL,
    signature text NOT NULL,
    status text NOT NULL,
    proposed_patch_json jsonb,
    approach_label text,
    confidence integer,
    validation_run_id text,
    validation_signature text,
    decision_actor text,
    decline_reason text,
    loop_attempt_count integer NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    publication_receipt text,
    publication_repair_after timestamp with time zone,
    publication_attempts integer DEFAULT 0 NOT NULL,
    validation_evidence_level text
);


--
-- Name: confidence_calibrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.confidence_calibrations (
    id text NOT NULL,
    org_id text NOT NULL,
    approach_label text NOT NULL,
    accept_rate real NOT NULL,
    sample_size integer NOT NULL,
    curve_slope real NOT NULL,
    curve_intercept real NOT NULL,
    last_computed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: credential_secret_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credential_secret_versions (
    id text NOT NULL,
    org_id text NOT NULL,
    credential_id text NOT NULL,
    version integer NOT NULL,
    ciphertext text NOT NULL,
    data_nonce text NOT NULL,
    data_tag text NOT NULL,
    wrapped_key text NOT NULL,
    wrap_nonce text NOT NULL,
    wrap_tag text NOT NULL,
    key_version integer DEFAULT 1 NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credentials (
    id text NOT NULL,
    org_id text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    secret_ref text NOT NULL,
    metadata jsonb,
    created_by text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp(3) with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone
);


--
-- Name: dead_letters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dead_letters (
    id text NOT NULL,
    org_id text DEFAULT 'default'::text NOT NULL,
    run_id text NOT NULL,
    node_id text NOT NULL,
    attempt integer DEFAULT 1 NOT NULL,
    workflow_json jsonb NOT NULL,
    node_json jsonb NOT NULL,
    error_json jsonb NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    replayed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    replay_claim_token text,
    replay_claimed_at timestamp with time zone,
    replay_mode text
);


--
-- Name: eval_datasets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eval_datasets (
    id text NOT NULL,
    org_id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    workflow_id text,
    example_count integer DEFAULT 0 NOT NULL,
    retention_days integer,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: eval_examples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.eval_examples (
    id text NOT NULL,
    org_id text NOT NULL,
    dataset_id text NOT NULL,
    source_feedback_id text NOT NULL,
    workflow_id text,
    dead_letter_id text,
    failure_signature text DEFAULT ''::text NOT NULL,
    input_context text DEFAULT ''::text NOT NULL,
    expected_approach_label text NOT NULL,
    accepted boolean DEFAULT true NOT NULL,
    suggestion_mode text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: experiments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.experiments (
    id text NOT NULL,
    org_id text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    control_ref text NOT NULL,
    candidate_ref text NOT NULL,
    eval_dataset_id text NOT NULL,
    scorer_kind text DEFAULT 'string_equality'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    summary_json jsonb,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: external_recovery_cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.external_recovery_cases (
    id text NOT NULL,
    org_id text NOT NULL,
    connection_id text NOT NULL,
    subject_key text NOT NULL,
    subject_kind text NOT NULL,
    external_workflow_id text NOT NULL,
    external_run_id text NOT NULL,
    external_step_id text,
    state text NOT NULL,
    failure_snapshot_json jsonb,
    evidence_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    first_detected_at timestamp with time zone NOT NULL,
    last_observed_at timestamp with time zone NOT NULL,
    observed_recovered_at timestamp with time zone,
    last_sequence bigint NOT NULL,
    last_event_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: external_run_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.external_run_steps (
    id text NOT NULL,
    org_id text NOT NULL,
    connection_id text NOT NULL,
    external_workflow_id text NOT NULL,
    external_run_id text NOT NULL,
    external_step_id text NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'unknown'::text NOT NULL,
    attempt integer DEFAULT 1 NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    snapshot_json jsonb,
    evidence_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    last_sequence bigint DEFAULT '-1'::integer NOT NULL,
    last_event_id text,
    last_observed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: external_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.external_runs (
    id text NOT NULL,
    org_id text NOT NULL,
    connection_id text NOT NULL,
    external_workflow_id text NOT NULL,
    external_run_id text NOT NULL,
    status text DEFAULT 'unknown'::text NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    snapshot_json jsonb,
    evidence_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    last_sequence bigint DEFAULT '-1'::integer NOT NULL,
    last_event_id text,
    last_observed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: external_runtime_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.external_runtime_connections (
    id text NOT NULL,
    org_id text NOT NULL,
    name text NOT NULL,
    runtime_key text NOT NULL,
    signing_credential_name text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: external_runtime_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.external_runtime_events (
    id text NOT NULL,
    org_id text NOT NULL,
    connection_id text NOT NULL,
    event_id text NOT NULL,
    source text NOT NULL,
    event_type text NOT NULL,
    subject text,
    event_time timestamp with time zone NOT NULL,
    sequence bigint NOT NULL,
    payload_json jsonb NOT NULL,
    projection_state text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: external_workflows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.external_workflows (
    id text NOT NULL,
    org_id text NOT NULL,
    connection_id text NOT NULL,
    external_workflow_id text NOT NULL,
    name text NOT NULL,
    version text,
    snapshot_json jsonb,
    evidence_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    last_sequence bigint DEFAULT '-1'::integer NOT NULL,
    last_event_id text,
    last_observed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: installed_plugins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.installed_plugins (
    id text NOT NULL,
    org_id text NOT NULL,
    plugin_id text NOT NULL,
    config_json jsonb,
    installed_by text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invitations (
    id text NOT NULL,
    org_id text NOT NULL,
    email text NOT NULL,
    role text DEFAULT 'viewer'::text NOT NULL,
    invited_by text,
    status text DEFAULT 'pending'::text NOT NULL,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: janusly_schema_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.janusly_schema_version (
    id integer NOT NULL,
    version_id bigint NOT NULL,
    is_applied boolean NOT NULL,
    tstamp timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: janusly_schema_version_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.janusly_schema_version ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.janusly_schema_version_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: mcp_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_connections (
    id text NOT NULL,
    org_id text NOT NULL,
    alias text NOT NULL,
    transport text NOT NULL,
    command text,
    args jsonb,
    url text,
    env_refs jsonb,
    enabled boolean DEFAULT true NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    status_reason text,
    expose_to_ai boolean DEFAULT false NOT NULL,
    last_discovery_at timestamp with time zone,
    created_by text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: mcp_tool_descriptors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_tool_descriptors (
    id text NOT NULL,
    connection_id text NOT NULL,
    name text NOT NULL,
    description text,
    input_schema jsonb,
    write_side boolean DEFAULT true NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    rate_limit_per_min integer,
    expose_to_ai boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: memory_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_entries (
    id text NOT NULL,
    org_id text NOT NULL,
    workflow_id text,
    run_id text,
    kind text NOT NULL,
    content text NOT NULL,
    embedding public.vector(1024) NOT NULL,
    embedding_provider text NOT NULL,
    embedding_model text NOT NULL,
    embedding_dimension integer NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retain_until timestamp with time zone NOT NULL,
    hold_until timestamp with time zone
);


--
-- Name: onboarding_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.onboarding_progress (
    id text NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    step text DEFAULT 'org_created'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    skipped_at timestamp with time zone,
    completed_at timestamp with time zone,
    restarted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: org_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_configs (
    id text NOT NULL,
    org_id text NOT NULL,
    key text NOT NULL,
    value_json jsonb NOT NULL,
    category text NOT NULL,
    description text NOT NULL,
    value_type text NOT NULL,
    source text DEFAULT 'tenant'::text NOT NULL,
    created_by text,
    updated_by text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: org_digest_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_digest_state (
    org_id text NOT NULL,
    last_sent_at timestamp with time zone NOT NULL
);


--
-- Name: org_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_members (
    id text NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    email text,
    role text DEFAULT 'viewer'::text NOT NULL,
    invited_by text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: org_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_roles (
    id text NOT NULL,
    org_id text NOT NULL,
    name text NOT NULL,
    inherits_from text NOT NULL,
    description text,
    is_builtin boolean DEFAULT false NOT NULL,
    granted_permissions jsonb,
    created_by text,
    updated_by text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizations (
    id text NOT NULL,
    name text NOT NULL,
    plan text DEFAULT 'free'::text NOT NULL,
    stripe_customer_id text,
    stripe_subscription_id text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: prompt_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompt_versions (
    id text NOT NULL,
    org_id text DEFAULT 'default'::text NOT NULL,
    prompt_id text NOT NULL,
    version integer NOT NULL,
    template_text text NOT NULL,
    variables jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'published'::text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: prompts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompts (
    id text NOT NULL,
    org_id text DEFAULT 'default'::text NOT NULL,
    name text NOT NULL,
    description text,
    pinned_version_id text,
    created_by text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: rate_limit_windows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limit_windows (
    name text NOT NULL,
    key text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    count integer DEFAULT 1 NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: recovery_case_transitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recovery_case_transitions (
    id text NOT NULL,
    org_id text NOT NULL,
    case_id text NOT NULL,
    from_state text NOT NULL,
    to_state text NOT NULL,
    actor_kind text NOT NULL,
    actor_id text,
    evidence_json jsonb NOT NULL,
    reason text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: recovery_cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recovery_cases (
    id text NOT NULL,
    org_id text NOT NULL,
    run_id text NOT NULL,
    workflow_id text,
    workflow_version_id text NOT NULL,
    source text NOT NULL,
    detector_id text NOT NULL,
    source_node_id text NOT NULL,
    detector_kind text NOT NULL,
    action text NOT NULL,
    message text NOT NULL,
    details_json jsonb,
    state text NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone
);


--
-- Name: recovery_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recovery_feedback (
    id text NOT NULL,
    org_id text NOT NULL,
    user_id text,
    dead_letter_id text NOT NULL,
    workflow_id text NOT NULL,
    suggestion_mode text NOT NULL,
    approach_label text NOT NULL,
    accepted boolean NOT NULL,
    raw_confidence integer,
    comment text,
    eval_consent boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    hold_until timestamp with time zone
);


--
-- Name: recovery_feedback_health; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recovery_feedback_health (
    id text NOT NULL,
    org_id text NOT NULL,
    workflow_id text NOT NULL,
    approach_label text NOT NULL,
    feedback_last_seen timestamp with time zone DEFAULT now() NOT NULL,
    accepted_fix_last_seen timestamp with time zone
);


--
-- Name: recovery_impact_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recovery_impact_events (
    dead_letter_id text NOT NULL,
    org_id text NOT NULL,
    run_id text NOT NULL,
    node_id text NOT NULL,
    user_id text,
    recovered_at timestamp with time zone NOT NULL,
    downtime_ended_ms bigint NOT NULL
);


--
-- Name: recovery_impact_rollups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recovery_impact_rollups (
    org_id text NOT NULL,
    total_recovered integer DEFAULT 0 NOT NULL,
    downtime_ended_ms bigint DEFAULT 0 NOT NULL,
    first_recovered_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: recovery_item_children; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recovery_item_children (
    id text NOT NULL,
    org_id text NOT NULL,
    recovery_item_id text NOT NULL,
    dead_letter_id text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: recovery_item_handoffs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recovery_item_handoffs (
    id text NOT NULL,
    org_id text NOT NULL,
    recovery_item_id text NOT NULL,
    destination text NOT NULL,
    credential_name text NOT NULL,
    external_id text,
    external_url text,
    idempotency_key text NOT NULL,
    last_outcome text NOT NULL,
    last_status_code integer,
    last_error text,
    last_latency_ms integer,
    dispatch_count integer DEFAULT 1 NOT NULL,
    first_dispatched_at timestamp with time zone DEFAULT now() NOT NULL,
    last_dispatched_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text
);


--
-- Name: recovery_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recovery_items (
    id text NOT NULL,
    org_id text NOT NULL,
    dead_letter_id text NOT NULL,
    workflow_id text,
    owner text,
    severity text DEFAULT 'p3'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    sla_target_at timestamp with time zone NOT NULL,
    resolution_reason text,
    resolved_by text,
    resolved_at timestamp with time zone,
    comments jsonb DEFAULT '[]'::jsonb NOT NULL,
    error_signature text,
    occurrence_count integer DEFAULT 1 NOT NULL,
    first_occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    last_occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    first_action_at timestamp with time zone
);


--
-- Name: recovery_playbooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recovery_playbooks (
    id text NOT NULL,
    org_id text NOT NULL,
    workflow_id text,
    signature text NOT NULL,
    version integer NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    title text NOT NULL,
    instructions_markdown text NOT NULL,
    evidence_requirements_json jsonb NOT NULL,
    source_workflow_version_id text NOT NULL,
    approach_label text DEFAULT 'other'::text NOT NULL,
    successful_uses integer DEFAULT 0 NOT NULL,
    regressions integer DEFAULT 0 NOT NULL,
    last_validated_at timestamp with time zone,
    last_validation_run_id text,
    last_applied_validation_run_id text,
    activated_at timestamp with time zone,
    retired_at timestamp with time zone,
    created_by text,
    updated_by text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: replay_campaign_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.replay_campaign_items (
    id text NOT NULL,
    org_id text NOT NULL,
    campaign_id text NOT NULL,
    dead_letter_id text NOT NULL,
    "position" integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    claim_token text,
    claimed_at timestamp with time zone,
    error text,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: replay_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.replay_campaigns (
    id text NOT NULL,
    org_id text NOT NULL,
    name text NOT NULL,
    cluster_signature text NOT NULL,
    filter_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    pacing_ms integer DEFAULT 1000 NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    total_count integer NOT NULL,
    replayed_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    cancelled_count integer DEFAULT 0 NOT NULL,
    created_by text NOT NULL,
    cancelled_by text,
    next_dispatch_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: routing_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.routing_stats (
    id text NOT NULL,
    org_id text NOT NULL,
    node_id text NOT NULL,
    pulls integer DEFAULT 0 NOT NULL,
    value real DEFAULT 0 NOT NULL,
    mean_reward real DEFAULT 0 NOT NULL,
    success_count integer DEFAULT 0 NOT NULL,
    failure_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: run_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_events (
    id text NOT NULL,
    run_id text NOT NULL,
    node_id text,
    type text NOT NULL,
    payload jsonb,
    created_at timestamp with time zone DEFAULT now(),
    hold_until timestamp with time zone
);


--
-- Name: run_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_nodes (
    id text NOT NULL,
    run_id text NOT NULL,
    node_id text NOT NULL,
    status text NOT NULL,
    state_json jsonb,
    attempts integer DEFAULT 0,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    error_json jsonb,
    recovery_dead_letter_id text,
    recovery_requested_by text,
    recovery_claim_token text,
    recovery_playbook_id text,
    recovery_validation_run_id text,
    waiting_repair_after timestamp with time zone,
    queue_publication_repair_after timestamp with time zone,
    queue_publication_generation integer DEFAULT 0 NOT NULL
);


--
-- Name: run_start_idempotency; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_start_idempotency (
    org_id text NOT NULL,
    idempotency_key text NOT NULL,
    run_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: run_wakeups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_wakeups (
    run_node_id text NOT NULL,
    wake_at timestamp with time zone NOT NULL,
    reason text NOT NULL
);


--
-- Name: runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runs (
    id text NOT NULL,
    org_id text DEFAULT 'default'::text NOT NULL,
    workflow_version_id text NOT NULL,
    status text NOT NULL,
    input_json jsonb,
    output_json jsonb,
    parent_run_id text,
    parent_node_id text,
    trace_id text,
    replay_mode text,
    created_by text,
    created_at timestamp with time zone DEFAULT now(),
    recovery_playbook_validation_recorded_at timestamp with time zone,
    recovery_playbook_applied_recorded_at timestamp with time zone,
    parent_link_kind text,
    parent_notification_after timestamp with time zone,
    workflow_rollout_id text,
    workflow_rollout_variant text,
    validation_evidence_level text,
    outcome_status text,
    semantic_violation_count integer DEFAULT 0 NOT NULL
);


--
-- Name: schedule_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_entries (
    id text NOT NULL,
    org_id text NOT NULL,
    workflow_id text NOT NULL,
    workflow_version_id text NOT NULL,
    node_id text NOT NULL,
    cron_expression text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    last_run_at timestamp with time zone,
    last_run_id text,
    created_by text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    next_fire_at timestamp with time zone
);


--
-- Name: scim_directories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scim_directories (
    id text NOT NULL,
    org_id text NOT NULL,
    provider_directory_id text NOT NULL,
    directory_type text,
    default_role text DEFAULT 'viewer'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    last_synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: scim_group_role_mappings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scim_group_role_mappings (
    id text NOT NULL,
    org_id text NOT NULL,
    scim_directory_id text NOT NULL,
    provider_group_id text NOT NULL,
    role text NOT NULL,
    created_by text,
    updated_by text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: scim_group_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scim_group_state (
    id text NOT NULL,
    org_id text NOT NULL,
    scim_directory_id text NOT NULL,
    provider_group_id text NOT NULL,
    name text NOT NULL,
    last_synced_at timestamp with time zone DEFAULT now()
);


--
-- Name: scim_processed_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scim_processed_events (
    event_id text NOT NULL,
    org_id text NOT NULL,
    scim_directory_id text NOT NULL,
    event_type text NOT NULL,
    processed_at timestamp with time zone DEFAULT now()
);


--
-- Name: scim_user_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scim_user_groups (
    id text NOT NULL,
    org_id text NOT NULL,
    scim_directory_id text NOT NULL,
    provider_user_id text NOT NULL,
    provider_group_id text NOT NULL,
    added_at timestamp with time zone DEFAULT now()
);


--
-- Name: scim_user_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scim_user_state (
    id text NOT NULL,
    org_id text NOT NULL,
    scim_directory_id text NOT NULL,
    provider_user_id text NOT NULL,
    email text NOT NULL,
    first_name text,
    last_name text,
    active boolean DEFAULT true NOT NULL,
    last_event_id text,
    last_event_timestamp timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: slack_interaction_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slack_interaction_connections (
    id text NOT NULL,
    org_id text NOT NULL,
    name text NOT NULL,
    team_id text NOT NULL,
    signing_credential_name text NOT NULL,
    user_mappings jsonb DEFAULT '[]'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: slack_interaction_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slack_interaction_receipts (
    id text NOT NULL,
    org_id text NOT NULL,
    connection_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: snippets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.snippets (
    id text NOT NULL,
    org_id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    category text NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    builtin boolean DEFAULT false NOT NULL,
    nodes_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    edges_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    entry_node_id text,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sso_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sso_connections (
    id text NOT NULL,
    org_id text NOT NULL,
    provider text NOT NULL,
    provider_connection_id text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    enforced_sso boolean DEFAULT false NOT NULL,
    config_json jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: sso_state_nonces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sso_state_nonces (
    id text NOT NULL,
    org_id text NOT NULL,
    nonce text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: trigger_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trigger_events (
    id text NOT NULL,
    org_id text NOT NULL,
    trigger_type text NOT NULL,
    workflow_id text,
    workflow_version_id text NOT NULL,
    node_id text NOT NULL,
    status text DEFAULT 'received'::text NOT NULL,
    run_id text,
    dedupe_key text,
    payload_json jsonb NOT NULL,
    skipped_reason text,
    created_at timestamp with time zone DEFAULT now(),
    backfill_claim_token text,
    backfill_claimed_at timestamp with time zone,
    workflow_rollout_id text,
    workflow_rollout_variant text
);


--
-- Name: upstream_health_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upstream_health_sources (
    id text NOT NULL,
    org_id text DEFAULT 'default'::text NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    url text NOT NULL,
    expected_components jsonb DEFAULT '[]'::jsonb NOT NULL,
    check_interval_seconds integer DEFAULT 60 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    last_status text,
    last_degraded boolean DEFAULT false NOT NULL,
    last_checked_at timestamp with time zone,
    last_error_reason text,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: usage_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_events (
    id text NOT NULL,
    org_id text NOT NULL,
    user_id text,
    run_id text,
    metric text NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now(),
    hold_until timestamp with time zone
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id text NOT NULL,
    email text,
    name text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: verified_domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verified_domains (
    id text NOT NULL,
    org_id text NOT NULL,
    domain text NOT NULL,
    default_role text DEFAULT 'viewer'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: workflow_budgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_budgets (
    id text NOT NULL,
    org_id text NOT NULL,
    workflow_id text NOT NULL,
    monthly_usd real NOT NULL,
    warn_percent integer DEFAULT 80 NOT NULL,
    policy text DEFAULT 'warn'::text NOT NULL,
    updated_by text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: workflow_improvements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_improvements (
    id text NOT NULL,
    org_id text NOT NULL,
    workflow_id text NOT NULL,
    base_version integer,
    new_version integer,
    action jsonb,
    reason text,
    before_metrics jsonb,
    after_metrics jsonb,
    confidence real DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: worker_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_instances (
    instance_id text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    worker_concurrency integer NOT NULL,
    build_commit text
);


--
-- Name: workflow_status_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_status_pages (
    org_id text NOT NULL,
    workflow_id text NOT NULL,
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_input_presets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_input_presets (
    id text NOT NULL,
    org_id text NOT NULL,
    workflow_id text NOT NULL,
    name text NOT NULL,
    input_json jsonb NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_metadata (
    id text NOT NULL,
    org_id text NOT NULL,
    workflow_id text NOT NULL,
    owners jsonb DEFAULT '[]'::jsonb NOT NULL,
    runbook_markdown text,
    description text,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    slack_channel text,
    linear_project text,
    severity_default text,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    folder text,
    ai_guidance_markdown text
);


--
-- Name: workflow_recovery_qualifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_recovery_qualifications (
    id text NOT NULL,
    org_id text NOT NULL,
    workflow_id text NOT NULL,
    baseline_version_id text NOT NULL,
    candidate_version_id text NOT NULL,
    dataset_version text NOT NULL,
    dataset_digest text NOT NULL,
    mode text NOT NULL,
    status text NOT NULL,
    summary_json jsonb NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_rollout_outcomes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_rollout_outcomes (
    run_id text NOT NULL,
    org_id text NOT NULL,
    rollout_id text NOT NULL,
    workflow_id text NOT NULL,
    variant text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_rollouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_rollouts (
    id text NOT NULL,
    org_id text NOT NULL,
    workflow_id text NOT NULL,
    baseline_version_id text NOT NULL,
    canary_version_id text NOT NULL,
    traffic_percent integer NOT NULL,
    minimum_sample_size integer NOT NULL,
    minimum_success_rate_percent integer NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    baseline_succeeded integer DEFAULT 0 NOT NULL,
    baseline_failed integer DEFAULT 0 NOT NULL,
    canary_succeeded integer DEFAULT 0 NOT NULL,
    canary_failed integer DEFAULT 0 NOT NULL,
    rolled_back_reason text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    last_outcome_at timestamp with time zone
);


--
-- Name: workflow_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_versions (
    id text NOT NULL,
    org_id text DEFAULT 'default'::text NOT NULL,
    workflow_id text NOT NULL,
    version integer NOT NULL,
    dag_json jsonb NOT NULL,
    slo_json jsonb,
    upstream_health_sources jsonb,
    created_by text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: workflows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflows (
    id text NOT NULL,
    org_id text DEFAULT 'default'::text NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    paused_reason text,
    created_by text,
    created_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone
);


--
-- Name: alert_dispatches alert_dispatches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_dispatches
    ADD CONSTRAINT alert_dispatches_pkey PRIMARY KEY (id);


--
-- Name: alert_policies alert_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alert_policies
    ADD CONSTRAINT alert_policies_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: auth_sessions auth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);


--
-- Name: auto_healing_runs auto_healing_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_healing_runs
    ADD CONSTRAINT auto_healing_runs_pkey PRIMARY KEY (id);


--
-- Name: confidence_calibrations confidence_calibrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.confidence_calibrations
    ADD CONSTRAINT confidence_calibrations_pkey PRIMARY KEY (id);


--
-- Name: credential_secret_versions credential_secret_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credential_secret_versions
    ADD CONSTRAINT credential_secret_versions_pkey PRIMARY KEY (id);


--
-- Name: credentials credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credentials
    ADD CONSTRAINT credentials_pkey PRIMARY KEY (id);


--
-- Name: dead_letters dead_letters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dead_letters
    ADD CONSTRAINT dead_letters_pkey PRIMARY KEY (id);


--
-- Name: eval_datasets eval_datasets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_datasets
    ADD CONSTRAINT eval_datasets_pkey PRIMARY KEY (id);


--
-- Name: eval_examples eval_examples_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.eval_examples
    ADD CONSTRAINT eval_examples_pkey PRIMARY KEY (id);


--
-- Name: experiments experiments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.experiments
    ADD CONSTRAINT experiments_pkey PRIMARY KEY (id);


--
-- Name: external_recovery_cases external_recovery_cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_recovery_cases
    ADD CONSTRAINT external_recovery_cases_pkey PRIMARY KEY (id);


--
-- Name: external_run_steps external_run_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_run_steps
    ADD CONSTRAINT external_run_steps_pkey PRIMARY KEY (id);


--
-- Name: external_runs external_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_runs
    ADD CONSTRAINT external_runs_pkey PRIMARY KEY (id);


--
-- Name: external_runtime_connections external_runtime_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_runtime_connections
    ADD CONSTRAINT external_runtime_connections_pkey PRIMARY KEY (id);


--
-- Name: external_runtime_events external_runtime_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_runtime_events
    ADD CONSTRAINT external_runtime_events_pkey PRIMARY KEY (id);


--
-- Name: external_workflows external_workflows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.external_workflows
    ADD CONSTRAINT external_workflows_pkey PRIMARY KEY (id);


--
-- Name: installed_plugins installed_plugins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.installed_plugins
    ADD CONSTRAINT installed_plugins_pkey PRIMARY KEY (id);


--
-- Name: invitations invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);


--
-- Name: janusly_schema_version janusly_schema_version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.janusly_schema_version
    ADD CONSTRAINT janusly_schema_version_pkey PRIMARY KEY (id);


--
-- Name: mcp_connections mcp_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_connections
    ADD CONSTRAINT mcp_connections_pkey PRIMARY KEY (id);


--
-- Name: mcp_tool_descriptors mcp_tool_descriptors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tool_descriptors
    ADD CONSTRAINT mcp_tool_descriptors_pkey PRIMARY KEY (id);


--
-- Name: memory_entries memory_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_entries
    ADD CONSTRAINT memory_entries_pkey PRIMARY KEY (id);


--
-- Name: onboarding_progress onboarding_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onboarding_progress
    ADD CONSTRAINT onboarding_progress_pkey PRIMARY KEY (id);


--
-- Name: org_configs org_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_configs
    ADD CONSTRAINT org_configs_pkey PRIMARY KEY (id);


--
-- Name: org_digest_state org_digest_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_digest_state
    ADD CONSTRAINT org_digest_state_pkey PRIMARY KEY (org_id);


--
-- Name: org_members org_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_pkey PRIMARY KEY (id);


--
-- Name: org_roles org_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_roles
    ADD CONSTRAINT org_roles_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: prompt_versions prompt_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_versions
    ADD CONSTRAINT prompt_versions_pkey PRIMARY KEY (id);


--
-- Name: prompts prompts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompts
    ADD CONSTRAINT prompts_pkey PRIMARY KEY (id);


--
-- Name: rate_limit_windows rate_limit_windows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit_windows
    ADD CONSTRAINT rate_limit_windows_pkey PRIMARY KEY (name, key, window_start);


--
-- Name: recovery_case_transitions recovery_case_transitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_case_transitions
    ADD CONSTRAINT recovery_case_transitions_pkey PRIMARY KEY (id);


--
-- Name: recovery_cases recovery_cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_cases
    ADD CONSTRAINT recovery_cases_pkey PRIMARY KEY (id);


--
-- Name: recovery_feedback_health recovery_feedback_health_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_feedback_health
    ADD CONSTRAINT recovery_feedback_health_pkey PRIMARY KEY (id);


--
-- Name: recovery_feedback recovery_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_feedback
    ADD CONSTRAINT recovery_feedback_pkey PRIMARY KEY (id);


--
-- Name: recovery_impact_events recovery_impact_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_impact_events
    ADD CONSTRAINT recovery_impact_events_pkey PRIMARY KEY (dead_letter_id);


--
-- Name: recovery_impact_rollups recovery_impact_rollups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_impact_rollups
    ADD CONSTRAINT recovery_impact_rollups_pkey PRIMARY KEY (org_id);


--
-- Name: recovery_item_children recovery_item_children_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_item_children
    ADD CONSTRAINT recovery_item_children_pkey PRIMARY KEY (id);


--
-- Name: recovery_item_handoffs recovery_item_handoffs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_item_handoffs
    ADD CONSTRAINT recovery_item_handoffs_pkey PRIMARY KEY (id);


--
-- Name: recovery_items recovery_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_items
    ADD CONSTRAINT recovery_items_pkey PRIMARY KEY (id);


--
-- Name: recovery_playbooks recovery_playbooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_playbooks
    ADD CONSTRAINT recovery_playbooks_pkey PRIMARY KEY (id);


--
-- Name: replay_campaign_items replay_campaign_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replay_campaign_items
    ADD CONSTRAINT replay_campaign_items_pkey PRIMARY KEY (id);


--
-- Name: replay_campaigns replay_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replay_campaigns
    ADD CONSTRAINT replay_campaigns_pkey PRIMARY KEY (id);


--
-- Name: routing_stats routing_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.routing_stats
    ADD CONSTRAINT routing_stats_pkey PRIMARY KEY (id);


--
-- Name: run_events run_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_events
    ADD CONSTRAINT run_events_pkey PRIMARY KEY (id);


--
-- Name: run_nodes run_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_nodes
    ADD CONSTRAINT run_nodes_pkey PRIMARY KEY (id);


--
-- Name: run_start_idempotency run_start_idempotency_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_start_idempotency
    ADD CONSTRAINT run_start_idempotency_pkey PRIMARY KEY (org_id, idempotency_key);


--
-- Name: run_wakeups run_wakeups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_wakeups
    ADD CONSTRAINT run_wakeups_pkey PRIMARY KEY (run_node_id);


--
-- Name: runs runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);


--
-- Name: schedule_entries schedule_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_entries
    ADD CONSTRAINT schedule_entries_pkey PRIMARY KEY (id);


--
-- Name: scim_directories scim_directories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scim_directories
    ADD CONSTRAINT scim_directories_pkey PRIMARY KEY (id);


--
-- Name: scim_group_role_mappings scim_group_role_mappings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scim_group_role_mappings
    ADD CONSTRAINT scim_group_role_mappings_pkey PRIMARY KEY (id);


--
-- Name: scim_group_state scim_group_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scim_group_state
    ADD CONSTRAINT scim_group_state_pkey PRIMARY KEY (id);


--
-- Name: scim_processed_events scim_processed_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scim_processed_events
    ADD CONSTRAINT scim_processed_events_pkey PRIMARY KEY (event_id);


--
-- Name: scim_user_groups scim_user_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scim_user_groups
    ADD CONSTRAINT scim_user_groups_pkey PRIMARY KEY (id);


--
-- Name: scim_user_state scim_user_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scim_user_state
    ADD CONSTRAINT scim_user_state_pkey PRIMARY KEY (id);


--
-- Name: slack_interaction_connections slack_interaction_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_interaction_connections
    ADD CONSTRAINT slack_interaction_connections_pkey PRIMARY KEY (id);


--
-- Name: slack_interaction_receipts slack_interaction_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_interaction_receipts
    ADD CONSTRAINT slack_interaction_receipts_pkey PRIMARY KEY (id);


--
-- Name: snippets snippets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snippets
    ADD CONSTRAINT snippets_pkey PRIMARY KEY (id);


--
-- Name: sso_connections sso_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sso_connections
    ADD CONSTRAINT sso_connections_pkey PRIMARY KEY (id);


--
-- Name: sso_state_nonces sso_state_nonces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sso_state_nonces
    ADD CONSTRAINT sso_state_nonces_pkey PRIMARY KEY (id);


--
-- Name: trigger_events trigger_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_events
    ADD CONSTRAINT trigger_events_pkey PRIMARY KEY (id);


--
-- Name: upstream_health_sources upstream_health_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upstream_health_sources
    ADD CONSTRAINT upstream_health_sources_pkey PRIMARY KEY (id);


--
-- Name: usage_events usage_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_events
    ADD CONSTRAINT usage_events_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: verified_domains verified_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verified_domains
    ADD CONSTRAINT verified_domains_pkey PRIMARY KEY (id);


--
-- Name: workflow_budgets workflow_budgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_budgets
    ADD CONSTRAINT workflow_budgets_pkey PRIMARY KEY (id);


--
-- Name: workflow_improvements workflow_improvements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_improvements
    ADD CONSTRAINT workflow_improvements_pkey PRIMARY KEY (id);


--
-- Name: worker_instances worker_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_instances
    ADD CONSTRAINT worker_instances_pkey PRIMARY KEY (instance_id);


--
-- Name: workflow_status_pages workflow_status_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_status_pages
    ADD CONSTRAINT workflow_status_pages_pkey PRIMARY KEY (org_id, workflow_id);


--
-- Name: workflow_input_presets workflow_input_presets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_input_presets
    ADD CONSTRAINT workflow_input_presets_pkey PRIMARY KEY (id);


--
-- Name: workflow_metadata workflow_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_metadata
    ADD CONSTRAINT workflow_metadata_pkey PRIMARY KEY (id);


--
-- Name: workflow_recovery_qualifications workflow_recovery_qualifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_recovery_qualifications
    ADD CONSTRAINT workflow_recovery_qualifications_pkey PRIMARY KEY (id);


--
-- Name: workflow_rollout_outcomes workflow_rollout_outcomes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_rollout_outcomes
    ADD CONSTRAINT workflow_rollout_outcomes_pkey PRIMARY KEY (run_id);


--
-- Name: workflow_rollouts workflow_rollouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_rollouts
    ADD CONSTRAINT workflow_rollouts_pkey PRIMARY KEY (id);


--
-- Name: workflow_versions workflow_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_versions
    ADD CONSTRAINT workflow_versions_pkey PRIMARY KEY (id);


--
-- Name: workflows workflows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_pkey PRIMARY KEY (id);


--
-- Name: alert_dispatches_org_dispatched_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alert_dispatches_org_dispatched_idx ON public.alert_dispatches USING btree (org_id, dispatched_at DESC NULLS LAST);


--
-- Name: alert_dispatches_org_policy_dedupe_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alert_dispatches_org_policy_dedupe_idx ON public.alert_dispatches USING btree (org_id, policy_id, dedupe_key, dispatched_at DESC NULLS LAST);


--
-- Name: alert_policies_org_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX alert_policies_org_name_idx ON public.alert_policies USING btree (org_id, name);


--
-- Name: alert_policies_org_trigger_enabled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alert_policies_org_trigger_enabled_idx ON public.alert_policies USING btree (org_id, trigger, enabled);


--
-- Name: audit_logs_metadata_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_metadata_gin_idx ON public.audit_logs USING gin (metadata jsonb_path_ops);


--
-- Name: audit_logs_org_action_created_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_org_action_created_id_idx ON public.audit_logs USING btree (org_id, action text_pattern_ops, created_at DESC, id DESC);


--
-- Name: audit_logs_org_created_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_org_created_id_idx ON public.audit_logs USING btree (org_id, created_at DESC, id DESC);


--
-- Name: auth_sessions_user_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_sessions_user_expiry_idx ON public.auth_sessions USING btree (user_id, expires_at);


--
-- Name: auto_healing_runs_dead_letter_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auto_healing_runs_dead_letter_key ON public.auto_healing_runs USING btree (dead_letter_id) WHERE (status = 'diagnosing'::text);


--
-- Name: auto_healing_runs_org_dlq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auto_healing_runs_org_dlq_idx ON public.auto_healing_runs USING btree (org_id, dead_letter_id);


--
-- Name: auto_healing_runs_org_signature_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auto_healing_runs_org_signature_created_idx ON public.auto_healing_runs USING btree (org_id, signature, created_at DESC NULLS LAST);


--
-- Name: auto_healing_runs_org_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auto_healing_runs_org_status_created_idx ON public.auto_healing_runs USING btree (org_id, status, created_at DESC NULLS LAST);


--
-- Name: auto_healing_runs_org_validated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auto_healing_runs_org_validated_idx ON public.auto_healing_runs USING btree (org_id) WHERE (status = 'validated'::text);


--
-- Name: auto_healing_runs_publication_repair_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auto_healing_runs_publication_repair_idx ON public.auto_healing_runs USING btree (publication_repair_after, id) WHERE ((publication_repair_after IS NOT NULL) AND (status = ANY (ARRAY['publishing'::text, 'publish_failed'::text])));


--
-- Name: confidence_calibrations_org_approach_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX confidence_calibrations_org_approach_idx ON public.confidence_calibrations USING btree (org_id, approach_label);


--
-- Name: credential_secret_versions_credential_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX credential_secret_versions_credential_version_idx ON public.credential_secret_versions USING btree (credential_id, version);


--
-- Name: credential_secret_versions_org_credential_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX credential_secret_versions_org_credential_idx ON public.credential_secret_versions USING btree (org_id, credential_id, created_at DESC NULLS LAST);


--
-- Name: credentials_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX credentials_org_idx ON public.credentials USING btree (org_id);


--
-- Name: credentials_org_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX credentials_org_name_idx ON public.credentials USING btree (org_id, name);


--
-- Name: dead_letters_org_created_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dead_letters_org_created_id_idx ON public.dead_letters USING btree (org_id, created_at DESC, id DESC);


--
-- Name: dead_letters_org_replay_claimed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dead_letters_org_replay_claimed_idx ON public.dead_letters USING btree (org_id, replay_claimed_at DESC NULLS LAST);


--
-- Name: dead_letters_org_run_node_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dead_letters_org_run_node_created_idx ON public.dead_letters USING btree (org_id, run_id, node_id, created_at);


--
-- Name: dead_letters_org_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dead_letters_org_status_created_idx ON public.dead_letters USING btree (org_id, status, created_at DESC, id DESC);


--
-- Name: eval_datasets_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX eval_datasets_org_created_idx ON public.eval_datasets USING btree (org_id, created_at DESC NULLS LAST);


--
-- Name: eval_datasets_org_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX eval_datasets_org_name_idx ON public.eval_datasets USING btree (org_id, name);


--
-- Name: eval_examples_org_dataset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX eval_examples_org_dataset_idx ON public.eval_examples USING btree (org_id, dataset_id);


--
-- Name: experiments_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX experiments_org_created_idx ON public.experiments USING btree (org_id, created_at DESC NULLS LAST);


--
-- Name: experiments_org_dataset_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX experiments_org_dataset_idx ON public.experiments USING btree (org_id, eval_dataset_id);


--
-- Name: external_recovery_cases_connection_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX external_recovery_cases_connection_subject_idx ON public.external_recovery_cases USING btree (connection_id, subject_key);


--
-- Name: external_recovery_cases_org_state_observed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX external_recovery_cases_org_state_observed_idx ON public.external_recovery_cases USING btree (org_id, state, last_observed_at DESC NULLS LAST);


--
-- Name: external_run_steps_connection_run_step_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX external_run_steps_connection_run_step_idx ON public.external_run_steps USING btree (connection_id, external_run_id, external_step_id);


--
-- Name: external_run_steps_org_observed_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX external_run_steps_org_observed_created_idx ON public.external_run_steps USING btree (org_id, last_observed_at DESC, created_at DESC);


--
-- Name: external_runs_connection_external_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX external_runs_connection_external_idx ON public.external_runs USING btree (connection_id, external_run_id);


--
-- Name: external_runs_connection_workflow_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX external_runs_connection_workflow_idx ON public.external_runs USING btree (connection_id, external_workflow_id, last_observed_at DESC NULLS LAST);


--
-- Name: external_runs_org_observed_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX external_runs_org_observed_created_idx ON public.external_runs USING btree (org_id, last_observed_at DESC, created_at DESC);


--
-- Name: external_runtime_connections_org_enabled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX external_runtime_connections_org_enabled_idx ON public.external_runtime_connections USING btree (org_id, enabled);


--
-- Name: external_runtime_connections_org_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX external_runtime_connections_org_name_idx ON public.external_runtime_connections USING btree (org_id, name);


--
-- Name: external_runtime_connections_org_runtime_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX external_runtime_connections_org_runtime_idx ON public.external_runtime_connections USING btree (org_id, runtime_key);


--
-- Name: external_runtime_events_connection_source_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX external_runtime_events_connection_source_event_idx ON public.external_runtime_events USING btree (connection_id, source, event_id);


--
-- Name: external_runtime_events_org_received_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX external_runtime_events_org_received_idx ON public.external_runtime_events USING btree (org_id, received_at DESC NULLS LAST);


--
-- Name: external_workflows_connection_external_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX external_workflows_connection_external_idx ON public.external_workflows USING btree (connection_id, external_workflow_id);


--
-- Name: external_workflows_org_observed_workflow_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX external_workflows_org_observed_workflow_idx ON public.external_workflows USING btree (org_id, last_observed_at DESC, external_workflow_id);


--
-- Name: installed_plugins_org_plugin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX installed_plugins_org_plugin_idx ON public.installed_plugins USING btree (org_id, plugin_id);


--
-- Name: invitations_org_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX invitations_org_email_idx ON public.invitations USING btree (org_id, email);


--
-- Name: mcp_connections_org_alias_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mcp_connections_org_alias_idx ON public.mcp_connections USING btree (org_id, alias);


--
-- Name: mcp_tool_descriptors_connection_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mcp_tool_descriptors_connection_name_idx ON public.mcp_tool_descriptors USING btree (connection_id, name);


--
-- Name: memory_entries_embedding_hnsw_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_entries_embedding_hnsw_idx ON public.memory_entries USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: memory_entries_org_kind_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_entries_org_kind_created_idx ON public.memory_entries USING btree (org_id, kind, created_at DESC NULLS LAST);


--
-- Name: memory_entries_org_retain_until_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_entries_org_retain_until_idx ON public.memory_entries USING btree (org_id, retain_until);


--
-- Name: onboarding_progress_org_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX onboarding_progress_org_user_idx ON public.onboarding_progress USING btree (org_id, user_id);


--
-- Name: org_configs_org_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX org_configs_org_category_idx ON public.org_configs USING btree (org_id, category);


--
-- Name: org_configs_org_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX org_configs_org_key_idx ON public.org_configs USING btree (org_id, key);


--
-- Name: org_members_org_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX org_members_org_user_idx ON public.org_members USING btree (org_id, user_id);


--
-- Name: org_roles_org_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX org_roles_org_name_idx ON public.org_roles USING btree (org_id, name);


--
-- Name: prompt_versions_org_prompt_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prompt_versions_org_prompt_created_idx ON public.prompt_versions USING btree (org_id, prompt_id, created_at DESC NULLS LAST);


--
-- Name: prompt_versions_org_prompt_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX prompt_versions_org_prompt_version_idx ON public.prompt_versions USING btree (org_id, prompt_id, version);


--
-- Name: prompts_org_created_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prompts_org_created_id_idx ON public.prompts USING btree (org_id, created_at DESC, id DESC);


--
-- Name: prompts_org_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX prompts_org_name_idx ON public.prompts USING btree (org_id, name);


--
-- Name: recovery_case_transitions_case_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_case_transitions_case_created_idx ON public.recovery_case_transitions USING btree (case_id, occurred_at);


--
-- Name: recovery_case_transitions_case_to_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX recovery_case_transitions_case_to_idx ON public.recovery_case_transitions USING btree (case_id, to_state);


--
-- Name: recovery_case_transitions_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_case_transitions_org_created_idx ON public.recovery_case_transitions USING btree (org_id, occurred_at DESC NULLS LAST);


--
-- Name: recovery_cases_org_run_detector_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX recovery_cases_org_run_detector_idx ON public.recovery_cases USING btree (org_id, run_id, detector_id);


--
-- Name: recovery_cases_org_state_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_cases_org_state_created_idx ON public.recovery_cases USING btree (org_id, state, created_at DESC NULLS LAST);


--
-- Name: recovery_cases_run_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_cases_run_source_idx ON public.recovery_cases USING btree (run_id, source_node_id);


--
-- Name: recovery_feedback_health_org_workflow_approach_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX recovery_feedback_health_org_workflow_approach_idx ON public.recovery_feedback_health USING btree (org_id, workflow_id, approach_label);


--
-- Name: recovery_feedback_health_org_workflow_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_feedback_health_org_workflow_idx ON public.recovery_feedback_health USING btree (org_id, workflow_id);


--
-- Name: recovery_feedback_org_dlq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_feedback_org_dlq_idx ON public.recovery_feedback USING btree (org_id, dead_letter_id);


--
-- Name: recovery_feedback_org_workflow_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_feedback_org_workflow_created_idx ON public.recovery_feedback USING btree (org_id, workflow_id, created_at DESC);


--
-- Name: recovery_impact_events_org_recovered_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_impact_events_org_recovered_idx ON public.recovery_impact_events USING btree (org_id, recovered_at DESC NULLS LAST);


--
-- Name: recovery_impact_events_org_user_recovered_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_impact_events_org_user_recovered_idx ON public.recovery_impact_events USING btree (org_id, user_id, recovered_at DESC NULLS LAST);


--
-- Name: recovery_item_children_item_dlq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX recovery_item_children_item_dlq_idx ON public.recovery_item_children USING btree (recovery_item_id, dead_letter_id);


--
-- Name: recovery_item_children_item_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_item_children_item_occurred_idx ON public.recovery_item_children USING btree (recovery_item_id, occurred_at DESC NULLS LAST);


--
-- Name: recovery_item_children_org_dlq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_item_children_org_dlq_idx ON public.recovery_item_children USING btree (org_id, dead_letter_id);


--
-- Name: recovery_item_handoffs_org_item_dest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX recovery_item_handoffs_org_item_dest_idx ON public.recovery_item_handoffs USING btree (org_id, recovery_item_id, destination);


--
-- Name: recovery_item_handoffs_org_lastdispatched_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_item_handoffs_org_lastdispatched_idx ON public.recovery_item_handoffs USING btree (org_id, last_dispatched_at DESC NULLS LAST);


--
-- Name: recovery_items_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_items_org_created_idx ON public.recovery_items USING btree (org_id, created_at);


--
-- Name: recovery_items_org_dlq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX recovery_items_org_dlq_idx ON public.recovery_items USING btree (org_id, dead_letter_id);


--
-- Name: recovery_items_org_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_items_org_owner_idx ON public.recovery_items USING btree (org_id, owner);


--
-- Name: recovery_items_org_signature_first_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_items_org_signature_first_idx ON public.recovery_items USING btree (org_id, error_signature, first_occurred_at);


--
-- Name: recovery_items_org_status_sla_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_items_org_status_sla_idx ON public.recovery_items USING btree (org_id, status, sla_target_at);


--
-- Name: recovery_items_org_wf_sig_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_items_org_wf_sig_idx ON public.recovery_items USING btree (org_id, workflow_id, error_signature);


--
-- Name: recovery_playbooks_one_active_match_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX recovery_playbooks_one_active_match_idx ON public.recovery_playbooks USING btree (org_id, workflow_id, signature) WHERE (status = 'active'::text);


--
-- Name: recovery_playbooks_org_signature_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_playbooks_org_signature_status_idx ON public.recovery_playbooks USING btree (org_id, signature, status);


--
-- Name: recovery_playbooks_org_signature_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX recovery_playbooks_org_signature_version_idx ON public.recovery_playbooks USING btree (org_id, signature, version);


--
-- Name: recovery_playbooks_org_source_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX recovery_playbooks_org_source_version_idx ON public.recovery_playbooks USING btree (org_id, source_workflow_version_id);


--
-- Name: recovery_playbooks_org_workflow_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_playbooks_org_workflow_idx ON public.recovery_playbooks USING btree (org_id, workflow_id);


--
-- Name: replay_campaign_items_campaign_dlq_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX replay_campaign_items_campaign_dlq_idx ON public.replay_campaign_items USING btree (campaign_id, dead_letter_id);


--
-- Name: replay_campaign_items_campaign_position_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX replay_campaign_items_campaign_position_idx ON public.replay_campaign_items USING btree (campaign_id, "position");


--
-- Name: replay_campaign_items_org_campaign_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX replay_campaign_items_org_campaign_status_idx ON public.replay_campaign_items USING btree (org_id, campaign_id, status, "position");


--
-- Name: replay_campaigns_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX replay_campaigns_due_idx ON public.replay_campaigns USING btree (next_dispatch_at, id) WHERE (status = 'running'::text);


--
-- Name: replay_campaigns_org_created_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX replay_campaigns_org_created_id_idx ON public.replay_campaigns USING btree (org_id, created_at DESC, id DESC);


--
-- Name: routing_stats_org_node_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX routing_stats_org_node_idx ON public.routing_stats USING btree (org_id, node_id);


--
-- Name: run_events_run_created_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_events_run_created_id_idx ON public.run_events USING btree (run_id, created_at, id);


--
-- Name: run_nodes_failed_finished_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_nodes_failed_finished_idx ON public.run_nodes USING btree (finished_at DESC, run_id) WHERE (status = 'failed'::text);


--
-- Name: run_nodes_queue_publication_repair_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_nodes_queue_publication_repair_idx ON public.run_nodes USING btree (queue_publication_repair_after, run_id, node_id) WHERE ((queue_publication_repair_after IS NOT NULL) AND (status = ANY (ARRAY['pending'::text, 'queued'::text])));


--
-- Name: run_nodes_queued_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_nodes_queued_claim_idx ON public.run_nodes USING btree (id) WHERE (status = 'queued'::text);


--
-- Name: run_nodes_run_node_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX run_nodes_run_node_idx ON public.run_nodes USING btree (run_id, node_id);


--
-- Name: run_nodes_running_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_nodes_running_started_idx ON public.run_nodes USING btree (started_at) WHERE (status = 'running'::text);


--
-- Name: run_nodes_waiting_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_nodes_waiting_target_idx ON public.run_nodes USING btree (waiting_repair_after NULLS FIRST, COALESCE((state_json #>> '{waiting,deadlineAt}'::text[]), (state_json #>> '{waiting,wakeAt}'::text[])), run_id, node_id) WHERE (status = 'waiting'::text);


--
-- Name: run_wakeups_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_wakeups_due_idx ON public.run_wakeups USING btree (wake_at);


--
-- Name: runs_org_created_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_org_created_id_idx ON public.runs USING btree (org_id, created_at DESC, id DESC);


--
-- Name: runs_org_status_created_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_org_status_created_id_idx ON public.runs USING btree (org_id, status, created_at DESC, id DESC);


--
-- Name: runs_org_replay_mode_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_org_replay_mode_idx ON public.runs USING btree (org_id, replay_mode);


--
-- Name: runs_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_parent_idx ON public.runs USING btree (parent_run_id);


--
-- Name: runs_parent_notification_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_parent_notification_idx ON public.runs USING btree (parent_notification_after, id) WHERE (parent_notification_after IS NOT NULL);


--
-- Name: runs_redrive_idempotency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX runs_redrive_idempotency_idx ON public.runs USING btree (org_id, parent_run_id, parent_node_id, workflow_version_id) WHERE ((parent_link_kind = 'replay'::text) AND (replay_mode IS NULL) AND (input_json ? 'redrive'::text));


--
-- Name: runs_rollout_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_rollout_idx ON public.runs USING btree (workflow_rollout_id, created_at DESC NULLS LAST);


--
-- Name: runs_workflow_version_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_workflow_version_created_idx ON public.runs USING btree (workflow_version_id, created_at DESC);


--
-- Name: schedule_entries_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX schedule_entries_due_idx ON public.schedule_entries USING btree (next_fire_at) WHERE (enabled = true);


--
-- Name: schedule_entries_org_enabled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX schedule_entries_org_enabled_idx ON public.schedule_entries USING btree (org_id, enabled);


--
-- Name: schedule_entries_org_version_node_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX schedule_entries_org_version_node_idx ON public.schedule_entries USING btree (org_id, workflow_version_id, node_id);


--
-- Name: schedule_entries_org_workflow_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX schedule_entries_org_workflow_idx ON public.schedule_entries USING btree (org_id, workflow_id);


--
-- Name: scim_directories_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX scim_directories_org_idx ON public.scim_directories USING btree (org_id);


--
-- Name: scim_directories_provider_directory_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX scim_directories_provider_directory_idx ON public.scim_directories USING btree (provider_directory_id);


--
-- Name: scim_group_role_mappings_directory_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX scim_group_role_mappings_directory_group_idx ON public.scim_group_role_mappings USING btree (scim_directory_id, provider_group_id);


--
-- Name: scim_group_role_mappings_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scim_group_role_mappings_org_idx ON public.scim_group_role_mappings USING btree (org_id);


--
-- Name: scim_group_state_directory_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX scim_group_state_directory_group_idx ON public.scim_group_state USING btree (scim_directory_id, provider_group_id);


--
-- Name: scim_processed_events_processed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scim_processed_events_processed_at_idx ON public.scim_processed_events USING btree (processed_at);


--
-- Name: scim_user_groups_directory_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scim_user_groups_directory_user_idx ON public.scim_user_groups USING btree (scim_directory_id, provider_user_id);


--
-- Name: scim_user_groups_user_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX scim_user_groups_user_group_idx ON public.scim_user_groups USING btree (scim_directory_id, provider_user_id, provider_group_id);


--
-- Name: scim_user_state_directory_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX scim_user_state_directory_user_idx ON public.scim_user_state USING btree (scim_directory_id, provider_user_id);


--
-- Name: scim_user_state_org_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scim_user_state_org_email_idx ON public.scim_user_state USING btree (org_id, email);


--
-- Name: slack_interaction_connections_org_enabled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX slack_interaction_connections_org_enabled_idx ON public.slack_interaction_connections USING btree (org_id, enabled);


--
-- Name: slack_interaction_connections_org_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX slack_interaction_connections_org_name_idx ON public.slack_interaction_connections USING btree (org_id, name);


--
-- Name: slack_interaction_connections_org_team_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX slack_interaction_connections_org_team_idx ON public.slack_interaction_connections USING btree (org_id, team_id);


--
-- Name: slack_interaction_receipts_connection_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX slack_interaction_receipts_connection_created_idx ON public.slack_interaction_receipts USING btree (connection_id, created_at);


--
-- Name: snippets_org_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX snippets_org_name_idx ON public.snippets USING btree (org_id, name);


--
-- Name: snippets_org_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX snippets_org_updated_idx ON public.snippets USING btree (org_id, updated_at DESC NULLS LAST);


--
-- Name: sso_connections_org_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sso_connections_org_provider_idx ON public.sso_connections USING btree (org_id, provider);


--
-- Name: sso_state_nonces_org_nonce_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sso_state_nonces_org_nonce_idx ON public.sso_state_nonces USING btree (org_id, nonce);


--
-- Name: trigger_events_backfill_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trigger_events_backfill_claim_idx ON public.trigger_events USING btree (org_id, workflow_id, backfill_claimed_at) WHERE (status = 'backfilling'::text);


--
-- Name: trigger_events_org_created_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trigger_events_org_created_id_idx ON public.trigger_events USING btree (org_id, created_at DESC, id DESC);


--
-- Name: trigger_events_org_dedupe_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX trigger_events_org_dedupe_idx ON public.trigger_events USING btree (org_id, dedupe_key);


--
-- Name: trigger_events_org_node_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trigger_events_org_node_idx ON public.trigger_events USING btree (org_id, workflow_version_id, node_id);


--
-- Name: trigger_events_org_workflow_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trigger_events_org_workflow_status_idx ON public.trigger_events USING btree (org_id, workflow_id, status, created_at);


--
-- Name: upstream_health_sources_enabled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX upstream_health_sources_enabled_idx ON public.upstream_health_sources USING btree (enabled);


--
-- Name: upstream_health_sources_org_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX upstream_health_sources_org_name_idx ON public.upstream_health_sources USING btree (org_id, name);


--
-- Name: usage_events_org_metric_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_events_org_metric_created_idx ON public.usage_events USING btree (org_id, metric, created_at DESC NULLS LAST);


--
-- Name: usage_events_org_metric_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_events_org_metric_idx ON public.usage_events USING btree (org_id, metric);


--
-- Name: usage_events_org_run_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usage_events_org_run_created_idx ON public.usage_events USING btree (org_id, run_id, created_at DESC NULLS LAST, id DESC NULLS LAST) WHERE (run_id IS NOT NULL);


--
-- Name: verified_domains_org_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX verified_domains_org_domain_idx ON public.verified_domains USING btree (org_id, domain);


--
-- Name: workflow_budgets_org_workflow_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workflow_budgets_org_workflow_idx ON public.workflow_budgets USING btree (org_id, workflow_id);


--
-- Name: workflow_improvements_org_workflow_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_improvements_org_workflow_idx ON public.workflow_improvements USING btree (org_id, workflow_id, created_at DESC NULLS LAST);


--
-- Name: workflow_status_pages_token_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workflow_status_pages_token_key ON public.workflow_status_pages USING btree (token);


--
-- Name: workflow_input_presets_org_wf_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workflow_input_presets_org_wf_name_key ON public.workflow_input_presets USING btree (org_id, workflow_id, name);


--
-- Name: workflow_metadata_org_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_metadata_org_updated_idx ON public.workflow_metadata USING btree (org_id, updated_at DESC NULLS LAST);


--
-- Name: workflow_metadata_org_workflow_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workflow_metadata_org_workflow_idx ON public.workflow_metadata USING btree (org_id, workflow_id);


--
-- Name: workflow_recovery_qualifications_exact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workflow_recovery_qualifications_exact_idx ON public.workflow_recovery_qualifications USING btree (org_id, workflow_id, baseline_version_id, candidate_version_id, dataset_version, dataset_digest);


--
-- Name: workflow_recovery_qualifications_pair_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_recovery_qualifications_pair_idx ON public.workflow_recovery_qualifications USING btree (org_id, workflow_id, baseline_version_id, candidate_version_id, created_at DESC NULLS LAST);


--
-- Name: workflow_rollout_outcomes_rollout_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_rollout_outcomes_rollout_created_idx ON public.workflow_rollout_outcomes USING btree (rollout_id, created_at);


--
-- Name: workflow_rollouts_one_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workflow_rollouts_one_active_idx ON public.workflow_rollouts USING btree (org_id, workflow_id) WHERE (status = 'active'::text);


--
-- Name: workflow_rollouts_org_workflow_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_rollouts_org_workflow_created_idx ON public.workflow_rollouts USING btree (org_id, workflow_id, created_at DESC NULLS LAST);


--
-- Name: workflow_versions_org_workflow_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflow_versions_org_workflow_created_idx ON public.workflow_versions USING btree (org_id, workflow_id, created_at DESC NULLS LAST);


--
-- Name: workflow_versions_org_workflow_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workflow_versions_org_workflow_version_idx ON public.workflow_versions USING btree (org_id, workflow_id, version);


--
-- Name: workflows_org_created_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflows_org_created_id_idx ON public.workflows USING btree (org_id, created_at DESC, id DESC);


--
-- Name: workflows_org_deleted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workflows_org_deleted_idx ON public.workflows USING btree (org_id, deleted_at DESC, id DESC) WHERE (deleted_at IS NOT NULL);


--
-- PostgreSQL database dump complete
--
