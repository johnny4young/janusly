// The closed org-config catalog, mechanically extracted from the
// former contract's orgConfigCatalog.ts: keys, categories,
// types, defaults, env overrides, ranges, allowed values, and the
// forbidden-name/value guards that keep credential-shaped material out of
// tenant settings. No DB access lives here — the persistence layer reads
// and writes against this static source of truth. Custom validators run
// after the standard type/trim/enum/range pipeline and are shared by both
// writes and defensive reads of stored rows.
package orgconfig

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"github.com/johnny4young/janusly/internal/httpcontract"

	"github.com/johnny4young/janusly/internal/ai"
	"github.com/johnny4young/janusly/internal/aiguidance"
	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/memorypolicy"
)

// Definition mirrors the contract's OrgConfigDefinition.
type Definition struct {
	Key           string   `json:"key"`
	Category      string   `json:"category"`
	Description   string   `json:"description"`
	ValueType     string   `json:"valueType"`
	Default       any      `json:"defaultValue"`
	EnvKeys       []string `json:"envKeys,omitempty"`
	AllowedValues []string `json:"allowedValues,omitempty"`
	Min           *float64 `json:"min,omitempty"`
	Max           *float64 `json:"max,omitempty"`
	AllowEmpty    bool     `json:"allowEmpty,omitempty"`
	Fractional    bool     `json:"fractional,omitempty"`
	// Validate runs after the standard normalization pipeline. It is not
	// serialized into the public catalog.
	Validate func(any) error `json:"-"`
}

// Forbidden-name / forbidden-value guards, verbatim from the contract.
var (
	ForbiddenNamePattern = regexp.MustCompile(
		`(?i)(secret|token|password|api[_-]?key|authorization|cookie|private[_-]?key|database[_-]?url|redis[_-]?url|supabase|service[_-]?role|service[_-]?token)`)
	ForbiddenValuePattern = regexp.MustCompile(
		`(?i)^(sk-|sk-ant-|xox[baprs]-|ghp_|github_pat_|ya29\.|AKIA|Bearer\s+)|^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.|-----BEGIN [A-Z ]+PRIVATE KEY-----|postgres(?:ql)?://|redis://`)
)

// Definitions is the closed catalog. Order matches the contract file.
var Definitions = []Definition{
	{Key: "ai.generationCandidates", Category: "ai", Description: "Best-of-N for AI workflow authoring: how many candidate workflows are sampled sequentially per request, rechecking the tenant budget before every provider call and keeping the best by a deterministic readiness score (no LLM judge). 1 (default) samples once; 2–5 trade additional bounded generation calls for lower per-prompt variance.", ValueType: "number", Default: float64(1), EnvKeys: []string{"JANUSLY_AI_GENERATION_CANDIDATES"}, Min: new(float64(1)), Max: new(float64(5))},
	{Key: "ai.anthropic.model", Category: "ai", Description: "Default Anthropic model for this tenant.", ValueType: "string", Default: "claude-haiku-4-5-20251001", EnvKeys: []string{"ANTHROPIC_MODEL"}, Validate: validateAnthropicModelID},
	{Key: "ai.operatorGuidance", Category: "ai", Description: "Bounded Janusly operator guidance for AI generation and recovery. Preferences only: cannot override security, workflow contracts, or system policy. Do not store secrets.", ValueType: "string", Default: "", AllowEmpty: true, Validate: validateAIOperatorGuidance},
	{Key: "ai.agentWriteConsent", Category: "ai", Description: "Allow agent and multi-agent planners to invoke write-capable tools only when the workflow also opts in, the process gate is enabled, and human approval dominates every path into the node. No env fallback by design; each tenant must opt in explicitly through the admin API.", ValueType: "boolean", Default: false},
	{Key: "ai.timeoutMs", Category: "ai", Description: "LLM request timeout in milliseconds.", ValueType: "number", Default: float64(30000), EnvKeys: []string{"JANUSLY_LLM_TIMEOUT_MS"}, Min: new(float64(1)), Max: new(float64(600000))},
	{Key: "ai.maxRetries", Category: "ai", Description: "AI SDK retry count for LLM calls.", ValueType: "number", Default: float64(2), EnvKeys: []string{"JANUSLY_LLM_MAX_RETRIES"}, Min: new(float64(0)), Max: new(float64(10))},
	{Key: "ai.maxOutputUnits", Category: "ai", Description: "Maximum output tokens allowed for one LLM provider call. Bounds spend and oversized replies without changing the provider-specific prompt contract.", ValueType: "number", Default: float64(4096), EnvKeys: []string{"JANUSLY_LLM_MAX_OUTPUT_UNITS"}, Min: new(float64(256)), Max: new(float64(16384))},
	{Key: "ai.promptMaxChars", Category: "ai", Description: "Maximum operator prompt length accepted by AI surfaces. Runtime context has an independent 64 KiB structured-data cap.", ValueType: "number", Default: float64(4000), EnvKeys: []string{"AI_PROMPT_MAX_CHARS"}, Min: new(float64(1)), Max: new(float64(65536))},
	{Key: "ai.rateLimitPerMin", Category: "ai", Description: "Per-org AI operation limit per minute, shared by API surfaces and workflow executor provider calls.", ValueType: "number", Default: float64(30), EnvKeys: []string{"AI_RATE_LIMIT_PER_MIN"}, Min: new(float64(1)), Max: new(float64(10000))},
	{Key: "ai.budgetMonthlyUsd", Category: "ai", Description: "Monthly recorded-spend threshold for the pre-call AI budget guard. New calls are warned/blocked after completed usage reaches it; concurrent or in-flight calls can finish above it because this is not a prepaid reservation. 0 disables the gate.", ValueType: "number", Default: float64(0), EnvKeys: []string{"JANUSLY_AI_BUDGET_MONTHLY_USD"}, Min: new(float64(0)), Fractional: true},
	{Key: "ai.budgetWarnPercent", Category: "ai", Description: "Percent of the monthly budget at which the operator gets a billing.budget.warned audit row + Recovery Center banner.", ValueType: "number", Default: float64(80), EnvKeys: []string{"JANUSLY_AI_BUDGET_WARN_PERCENT"}, Min: new(float64(0)), Max: new(float64(100))},
	{Key: "ai.budgetExceededPolicy", Category: "ai", Description: "What happens when the monthly budget is exceeded. 'warn' proceeds + audits + toasts; 'block' returns HTTP 402 / mode=fallback.", ValueType: "string", Default: "warn", EnvKeys: []string{"JANUSLY_AI_BUDGET_EXCEEDED_POLICY"}, AllowedValues: []string{"warn", "block"}},
	{Key: "ai.confidenceCalibrationEnabled", Category: "ai", Description: "Tenant switch for calibrating AI patch-suggestion confidence against observed accept/reject history. Defaults to true: a daily sweep fits a per-approach linear curve from recovery feedback and the recovery dialog shows the calibrated value as primary. Set false to show the model's raw self-rated confidence unchanged (no curve fit, no calibrated number).", ValueType: "boolean", Default: true},
	{Key: "http.timeoutMs", Category: "http", Description: "Default outbound HTTP timeout budget in milliseconds.", ValueType: "number", Default: float64(httpcontract.DefaultTimeoutMS), EnvKeys: []string{"JANUSLY_HTTP_TIMEOUT_MS"}, Min: new(float64(1)), Max: new(float64(httpcontract.MaxTimeoutMS))},
	{Key: "http.maxResponseBytes", Category: "http", Description: "Default maximum decoded body size for HTTP nodes and http.request.", ValueType: "number", Default: float64(httpcontract.DefaultMaxResponseBytes), EnvKeys: []string{"JANUSLY_HTTP_MAX_RESPONSE_BYTES"}, Min: new(float64(1)), Max: new(float64(httpcontract.MaxResponseBytes))},
	{Key: "http.maxRedirects", Category: "http", Description: "Default maximum redirect hops for outbound HTTP.", ValueType: "number", Default: float64(httpcontract.DefaultMaxRedirects), EnvKeys: []string{"JANUSLY_HTTP_MAX_REDIRECTS"}, Min: new(float64(0)), Max: new(float64(httpcontract.MaxRedirects))},
	{Key: "http.streamPreviewBytes", Category: "http", Description: "How many bytes of a streamed HTTP response body get captured into the persisted node output for audit when `bodyMode: \"stream\"` is set on an `http` node or `http.request` tool. The full response still flows through the byte cap (`http.maxResponseBytes`); only the preview is what survives into `run_nodes.state_json`. Range 1024..1048576 (1 KB..1 MB), default 65536 (64 KB).", ValueType: "number", Default: float64(httpcontract.DefaultStreamPreview), EnvKeys: []string{"JANUSLY_HTTP_STREAM_PREVIEW_BYTES"}, Min: new(float64(httpcontract.MinStreamPreview)), Max: new(float64(httpcontract.MaxStreamPreview))},
	{Key: "email.provider", Category: "email", Description: "Default mailer provider for this tenant. Provider API keys still come from env or secret management.", ValueType: "string", Default: "noop", EnvKeys: []string{"JANUSLY_MAILER_PROVIDER"}, AllowedValues: []string{"resend", "sendgrid", "simulator", "noop"}},
	{Key: "email.from", Category: "email", Description: "Default sender address for email.send when the workflow input omits from.", ValueType: "string", Default: "onboarding@resend.dev", EnvKeys: []string{"JANUSLY_MAILER_FROM"}},
	{Key: "email.rateLimitPerMin", Category: "email", Description: "Per-org email.send limit per minute.", ValueType: "number", Default: float64(100), EnvKeys: []string{"JANUSLY_EMAIL_RATE_LIMIT_PER_MIN"}, Min: new(float64(1))},
	{Key: "digest.weeklyEnabled", Category: "email", Description: "Send a weekly operations digest (run totals and open failures over the last 7 days) to this organization's admins through the configured mailer. Off by default; with the noop mailer nothing is sent.", ValueType: "boolean", Default: false},
	{Key: "runs.requireSavedWorkflow", Category: "runs", Description: "Require runs to start from a saved workflow instead of an ad-hoc payload.", ValueType: "boolean", Default: false, EnvKeys: []string{"JANUSLY_REQUIRE_SAVED_WORKFLOW"}},
	{Key: "subworkflow.maxDepth", Category: "runs", Description: "Maximum nested subworkflow depth.", ValueType: "number", Default: float64(5), EnvKeys: []string{"JANUSLY_MAX_SUBWORKFLOW_DEPTH"}, Min: new(float64(1))},
	{Key: "runs.streamMaxSubscriptions", Category: "runs", Description: "Maximum concurrent live-run SSE subscriptions per organization (per API replica).", ValueType: "number", Default: float64(50), EnvKeys: []string{"JANUSLY_STREAM_MAX_SUBSCRIPTIONS"}, Min: new(float64(1)), Max: new(float64(1000))},
	{Key: "runs.circuitBreakerThreshold", Category: "runs", Description: "Consecutive failed ordinary runs that pause a workflow via its circuit breaker. Range 2..100, default 5 (a threshold of 1 would be a hair trigger). A per-workflow `config.recovery.circuitBreaker.consecutiveFailures` overrides this; setting that to `false` opts a workflow out entirely.", ValueType: "number", Default: float64(5), Min: new(float64(2)), Max: new(float64(100))},
	{Key: "runs.humanFormResumeTtlSeconds", Category: "runs", Description: "Lifetime of newly-issued human-form resume tokens, in seconds. Range 300..604800 (5 minutes..7 days), default 604800. Each token carries its signed expiry, so changing this affects only tokens issued afterwards.", ValueType: "number", Default: float64(604800), Min: new(float64(300)), Max: new(float64(604800))},
	{Key: "mcp.writeConsent", Category: "mcp", Description: "Allow MCP write tools (workflows.save, etc.) to mutate this organization. Process-wide JANUSLY_MCP_WRITES_ENABLED must also be true. NO env fallback by design \u2014 each tenant must opt in explicitly via the admin API.", ValueType: "boolean", Default: false},
	{Key: "mcp.clientWriteConsent", Category: "mcp", Description: "Allow Janusly's `mcp_tool` workflow steps to invoke write-side tools on external MCP servers. Process-wide JANUSLY_MCP_CLIENT_WRITES_ENABLED must also be true. NO env fallback by design \u2014 each tenant must opt in explicitly via the admin API.", ValueType: "boolean", Default: false},
	{Key: "mcp.clientRateLimitPerMin", Category: "mcp", Description: "Per-org rate limit for external `mcp_tool` invocations (per minute, applied as `mcp_client.<alias>.<toolName>` bucket).", ValueType: "number", Default: float64(60), EnvKeys: []string{"JANUSLY_MCP_CLIENT_RATE_LIMIT_PER_MIN"}, Min: new(float64(1))},
	{Key: "mcp.clientCommandAllowlist", Category: "mcp", Description: "Comma-separated list of executable commands that stdio MCP connections in this org may spawn (e.g. \"node,uvx,npx\"). Empty = falls back to the process-wide JANUSLY_MCP_ALLOWED_COMMANDS env. The fail-closed posture means no stdio connection can be created unless at least one allowlist (env OR tenant) is non-empty.", ValueType: "string", Default: "", EnvKeys: []string{"JANUSLY_MCP_ALLOWED_COMMANDS"}, AllowEmpty: true},
	{Key: "mcp.stdioMaxLifetimeMs", Category: "mcp", Description: "Max wall-clock lifetime in milliseconds for a stdio MCP child process. The sandbox layer kills the child (SIGTERM then SIGKILL after a short grace) past this. Range 60000..3600000 (1 min..1 h).", ValueType: "number", Default: float64(600000), EnvKeys: []string{"JANUSLY_MCP_STDIO_MAX_LIFETIME_MS"}, Min: new(float64(60000)), Max: new(float64(3600000))},
	{Key: "mcp.stdioMaxStderrBytes", Category: "mcp", Description: "Max bytes of stderr the sandbox captures from a stdio MCP child before killing it. Captured stderr is secret-shape redacted before logging. Range 1024..1048576 (1 KiB..1 MiB).", ValueType: "number", Default: float64(65536), EnvKeys: []string{"JANUSLY_MCP_STDIO_MAX_STDERR_BYTES"}, Min: new(float64(1024)), Max: new(float64(1048576))},
	{Key: "mcp.stdioMaxVmKb", Category: "mcp", Description: "Reserved virtual-memory cap (KB) for stdio MCP children. NOT enforced by the current runtime: the production image is distroless and carries no prlimit, and Go cannot set a child rlimit without one. The active sandbox bounds are the command allowlist, env whitelist, bounded lifetime, and capped stderr; the container's own memory limit bounds the process tree. Kept for forward compatibility. Range 131072..4194304 (128 MiB..4 GiB).", ValueType: "number", Default: float64(524288), EnvKeys: []string{"JANUSLY_MCP_STDIO_MAX_VM_KB"}, Min: new(float64(131072)), Max: new(float64(4194304))},
	{Key: "slack.rateLimitPerMin", Category: "integrations", Description: "Per-org slack.post tool calls per minute.", ValueType: "number", Default: float64(60), EnvKeys: []string{"JANUSLY_SLACK_RATE_LIMIT_PER_MIN"}, Min: new(float64(1))},
	{Key: "github.rateLimitPerMin", Category: "integrations", Description: "Per-org github.create_issue tool calls per minute.", ValueType: "number", Default: float64(60), EnvKeys: []string{"JANUSLY_GITHUB_RATE_LIMIT_PER_MIN"}, Min: new(float64(1))},
	{Key: "webhook.rateLimitPerMin", Category: "integrations", Description: "Per-org webhook.send tool calls per minute.", ValueType: "number", Default: float64(120), EnvKeys: []string{"JANUSLY_WEBHOOK_RATE_LIMIT_PER_MIN"}, Min: new(float64(1))},
	{Key: "pdf.rateLimitPerMin", Category: "integrations", Description: "Per-org pdf.generate tool calls per minute.", ValueType: "number", Default: float64(30), EnvKeys: []string{"JANUSLY_PDF_RATE_LIMIT_PER_MIN"}, Min: new(float64(1))},
	{Key: "db.rateLimitPerMin", Category: "integrations", Description: "Per-org db.schema.describe / db.query.* tool calls per minute.", ValueType: "number", Default: float64(60), EnvKeys: []string{"JANUSLY_DB_TOOL_RATE_LIMIT_PER_MIN"}, Min: new(float64(1))},
	{Key: "objectstore.provider", Category: "objectstore", Description: "Object-store backend used by pdf.generate. Provider credentials still come from env.", ValueType: "string", Default: "noop", EnvKeys: []string{"JANUSLY_OBJECT_STORE_PROVIDER"}, AllowedValues: []string{"s3", "local", "noop"}},
	{Key: "auth.allowedEmailDomains", Category: "auth", Description: "Comma-separated list of email domains permitted to authenticate into this org (e.g. \"acme.com,partner.com\"). Empty = no restriction. The membership resolver rejects any principal whose email domain is not in the list. Applies to both Supabase JWT logins and post-callback SSO sessions \u2014 defense in depth against an IdP that surfaces users from unintended domains.", ValueType: "string", Default: "", AllowEmpty: true},
	{Key: "auth.mfaRequired", Category: "auth", Description: "Marker only \u2014 Janusly stores the requirement for policy visibility but does not block logins. Actual MFA enforcement happens at the identity provider (Okta, Azure AD, etc.). When set, the policy evaluator logs a server-side warning if the principal lacks a verifiable MFA hint.", ValueType: "boolean", Default: false},
	{Key: "auth.sessionTtlSeconds", Category: "auth", Description: "Per-org override for the WorkOS browser-session TTL (in seconds). Range 300..86400 (5 minutes..24 hours). Default 28800 (8 hours). The SSO callback reads this when it creates the revocable server-side session, so changing it only affects newly-created sessions.", ValueType: "number", Default: float64(28800), Min: new(float64(300)), Max: new(float64(86400))},
	{Key: "memory.enabled", Category: "memory", Description: "Tenant master switch for persistent cross-run memory. Required true (alongside JANUSLY_MEMORY_ENABLED=true at the process level) for any memory write. NO env fallback by design \u2014 each tenant must opt in explicitly via the admin API. Defaults to false (off). See docs/memory-policy.md.", ValueType: "boolean", Default: false},
	{Key: "memory.allowedKinds", Category: "memory", Description: "Comma-separated list of memory kinds eligible for write in this org. Closed enum: recovery_rationale, run_summary, runbook_fragment, patch_rationale, generated_workflow, workflow_vector, agent_episode. Empty = no kinds enabled (memory feature is on but no writes accepted yet). See docs/memory-policy.md.", ValueType: "string", Default: "", AllowEmpty: true, Validate: validateMemoryAllowedKinds},
	{Key: "memory.retentionDaysByKind", Category: "memory", Description: "JSON-encoded per-kind retention override (e.g. {\"recovery_rationale\":180,\"run_summary\":90}). Empty = use the per-kind defaults from docs/memory-policy.md. Each value is a positive integer day count bounded by the per-kind maximum from the policy table.", ValueType: "string", Default: "", AllowEmpty: true, Validate: validateMemoryRetentionDaysByKind},
	{Key: "memory.recallMaxEntries", Category: "memory", Description: "Hard cap on the number of memory entries returned per recall call. Range 1..32, default 8. See docs/memory-policy.md.", ValueType: "number", Default: float64(8), Min: new(float64(1)), Max: new(float64(32))},
	{Key: "memory.recallMaxBytes", Category: "memory", Description: "Hard cap on the total bytes returned per recall call. Range 1024..65536 (1 KiB..64 KiB), default 8192. See docs/memory-policy.md.", ValueType: "number", Default: float64(8192), Min: new(float64(1024)), Max: new(float64(65536))},
	{Key: "memory.embeddingModel", Category: "memory", Description: "Ollama model id used to compute embeddings for memory entries. Empty = use the env default (bge-m3). Stored on each entry for explicit re-embedding when the model changes. See docs/memory-policy.md.", ValueType: "string", Default: "", EnvKeys: []string{"JANUSLY_EMBEDDING_MODEL"}, AllowEmpty: true, Validate: validateEmbeddingModel},
	{Key: "memory.embeddingBaseUrl", Category: "memory", Description: "Base URL of the embedding service when the operator runs an external instance (e.g. a remote Ollama box). Empty = use the env default (OLLAMA_BASE_URL, defaulting to http://ollama:11434 inside Compose). A value set here is org-admin input, so the embedding fetch enforces the outbound SSRF policy (validation + DNS pinning); only the operator env default may point at private infrastructure.", ValueType: "string", Default: "", EnvKeys: []string{"OLLAMA_BASE_URL"}, AllowEmpty: true, Validate: validateEmbeddingBaseURL},
	{Key: "autoHealing.enabled", Category: "auto-healing", Description: "Tenant master switch for supervised auto-healing. Required true (alongside JANUSLY_AUTO_HEALING_ENABLED=true at the process level) for the background scanner to consider this org's DLQ rows. NO env fallback by design \u2014 each tenant must opt in explicitly via the admin API. Defaults to false (off); the scanner skips every step before reading the recent DLQ window.", ValueType: "boolean", Default: false},
	{Key: "autoHealing.autoApply", Category: "auto-healing", Description: "Tenant opt-in for automatic application of validated patches without operator click. Required true (alongside JANUSLY_AUTO_HEALING_AUTO_APPLY=true at the process level) for the watcher's auto-apply branch to fire. Independent of autoHealing.enabled \u2014 both apply only when the master gate is also on. Defaults to false; the watcher leaves validated rows pending operator decision.", ValueType: "boolean", Default: false},
	{Key: "autoHealing.maxAttemptsPerSignature", Category: "auto-healing", Description: "Loop-breaker ceiling: the same normalized failure signature can be auto-healed at most this many times inside the loop window. The count is over prior auto_healing_runs rows for (orgId, signature) and is captured at diagnose time. Range 1..10, default 3.", ValueType: "number", Default: float64(3), Min: new(float64(1)), Max: new(float64(10))},
	{Key: "autoHealing.loopWindowDays", Category: "auto-healing", Description: "Loop-breaker window in days: prior auto_healing_runs rows for (orgId, signature) older than this are not counted against the per-signature cap. Range 1..90, default 14.", ValueType: "number", Default: float64(14), Min: new(float64(1)), Max: new(float64(90))},
	{Key: "recovery.autoCreateItems", Category: "recovery", Description: "Tenant switch for automatic recovery item creation when a DLQ row is inserted. Defaults to true so the ownership workflow is on for existing tenants; operators can disable it per org through the closed org config catalog.", ValueType: "boolean", Default: true},
	{Key: "recovery.debounceWindowSeconds", Category: "recovery", Description: "Failure-storm debounce window. A new DLQ entry sharing (orgId, workflowId, errorSignature) with a still-open recovery item whose last occurrence is within this many seconds attaches as a child occurrence instead of spawning a new incident. Default 300; recommended operating range 30..3600; 0 disables debounce (one item per DLQ row). Non-zero values below 30 are clamped up to 30 by the engine.", ValueType: "number", Default: float64(300), Min: new(float64(0)), Max: new(float64(3600))},
	{Key: "recovery.slaPolicies", Category: "recovery", Description: "Per-severity recovery SLA targets, in minutes, as a JSON object keyed by severity (p1..p4) \u2014 e.g. {\"p1\":30,\"p2\":120}. Sets each incident's slaTargetAt at creation (createdAt + minutes); the breach scanner fires recovery_item.sla_breached when an item isn't resolved by then. Empty string (default) uses the built-in defaults (p1=60, p2=240, p3=1440, p4=10080 minutes). A partial map is allowed \u2014 omitted severities keep their default. Per-severity range 1..43200 minutes (30 days, matching the per-item override cap). A per-item slaTargetAtOverrideIso at acknowledge/escalate still wins over this.", ValueType: "string", Default: "", AllowEmpty: true, Validate: validateRecoverySLAPolicies},
	{Key: "value.hourlyCost", Category: "value", Description: "Operator-supplied 'engineer hourly cost' assumption used by the Value Dashboard's dollar-savings estimate. Pure assumption: Janusly never measures payroll. Range 0..2000, default 50 (USD-equivalent; currency formatting is locale-driven on the client). Fractional values supported so $125.75 doesn't silently truncate to $125. Every dollar surface in the UI carries an 'estimate' badge linking back to this knob.", ValueType: "number", Default: float64(50), Min: new(float64(0)), Max: new(float64(2000)), Fractional: true},
	{Key: "value.minutesSavedPerRecovery", Category: "value", Description: "Operator-supplied 'minutes saved per resolved failure' assumption used by the Value Dashboard. Drives hours-saved + dollar-saved estimates via clustersResolved * value / 60 * hourlyCost. Range 0..480, default 30. Tune to match the operator's manual-triage baseline measured during the private-beta MTTR experiment.", ValueType: "number", Default: float64(30), Min: new(float64(0)), Max: new(float64(480))},
	{Key: "value.baselineMttrSeconds", Category: "value", Description: "Operator-supplied 'pre-Janusly MTTR' baseline (seconds) used by the Value Dashboard's before/after comparison. Default 0 is the sentinel for 'baseline not measured yet' \u2014 the dashboard renders 'Awaiting private-beta data' in the 'Before' slot until the operator sets a real value (typically after the discovery call with a design partner). Range 0..86400 (one day).", ValueType: "number", Default: float64(0), Min: new(float64(0)), Max: new(float64(86400))},
	{Key: "retention.runEventsDays", Category: "retention", Description: "Days of run-event history (`run_events`) kept before the daily retention sweep purges them, scoped to this org. Run timelines older than this are deleted unless a per-row `holdUntil` legal hold is in force. Range 7..365, default 90.", ValueType: "number", Default: float64(90), EnvKeys: []string{"JANUSLY_RETENTION_RUN_EVENTS_DAYS"}, Min: new(float64(7)), Max: new(float64(365))},
	{Key: "retention.archiveRunEvents", Category: "retention", Description: "Export expiring run events to the configured object store as JSONL before the retention sweep deletes them. Requires JANUSLY_OBJECT_STORE_PROVIDER; with the default noop provider nothing is archived and nothing is deleted from the archived batches. Objects land under orgs/<orgId>/archive/run-events/. Defaults to false.", ValueType: "boolean", Default: false, EnvKeys: []string{"JANUSLY_RETENTION_ARCHIVE_RUN_EVENTS"}},
	{Key: "retention.auditLogsDays", Category: "retention", Description: "Days of audit-log history (`audit_logs`) kept for this org before the daily retention sweep purges them. The floor is 30 days but the default is 365 to satisfy common compliance evidence windows; a per-row `holdUntil` legal hold exempts rows referenced by an active investigation. Range 30..730, default 365.", ValueType: "number", Default: float64(365), EnvKeys: []string{"JANUSLY_RETENTION_AUDIT_LOGS_DAYS"}, Min: new(float64(30)), Max: new(float64(730))},
	{Key: "retention.usageEventsDays", Category: "retention", Description: "Days of usage-event history (`usage_events`) kept for this org before the daily retention sweep purges them. Drives billing/value-dashboard rollups, so the floor is 30 days. A per-row `holdUntil` legal hold exempts a row. Range 30..365, default 90.", ValueType: "number", Default: float64(90), EnvKeys: []string{"JANUSLY_RETENTION_USAGE_EVENTS_DAYS"}, Min: new(float64(30)), Max: new(float64(365))},
	{Key: "retention.deadLettersDays", Category: "retention", Description: "Days a settled dead letter (`replayed` or `resolved`) is kept for this org before the daily retention sweep purges it, by `created_at`. Open dead letters never age out: the recovery queue is operator-owned until it is acted on. Range 30..730, default 180.", ValueType: "number", Default: float64(180), EnvKeys: []string{"JANUSLY_RETENTION_DEAD_LETTERS_DAYS"}, Min: new(float64(30)), Max: new(float64(730))},
	{Key: "retention.recoveryFeedbackDays", Category: "retention", Description: "Days of recovery-feedback history (`recovery_feedback`) kept for this org before the daily retention sweep purges them. The labeled accept/reject signal feeds the AI patch loop, so the floor is 30 days. A per-row `holdUntil` legal hold exempts a row. Range 30..365, default 180.", ValueType: "number", Default: float64(180), EnvKeys: []string{"JANUSLY_RETENTION_RECOVERY_FEEDBACK_DAYS"}, Min: new(float64(30)), Max: new(float64(365))},
	{Key: "retention.memoryEntriesDays", Category: "retention", Description: "Days of memory-entry history (`memory_entries`) kept for this org before the daily retention sweep purges them, by `created_at`. Gated by the memory policy (docs/memory-policy.md); independent of and an upper bound over the per-kind `retain_until` expiry, so a row is removed by whichever of the two fires first. A per-row `holdUntil` legal hold exempts a row from the org-level sweep. Range 7..730, default 90.", ValueType: "number", Default: float64(90), EnvKeys: []string{"JANUSLY_RETENTION_MEMORY_ENTRIES_DAYS"}, Min: new(float64(7)), Max: new(float64(730))},
	{Key: "retention.deletedWorkflowsDays", Category: "retention", Description: "Days a soft-deleted workflow (DELETE /workflows/:id sets `deletedAt`) is kept before the daily retention sweep HARD-purges it + its versions + metadata, by `deleted_at`. This is the recovery window: within it, POST /workflows/:id/restore brings the workflow back. Range 1..365, default 30.", ValueType: "number", Default: float64(30), EnvKeys: []string{"JANUSLY_RETENTION_DELETED_WORKFLOWS_DAYS"}, Min: new(float64(1)), Max: new(float64(365))},
	{Key: "onboarding.enabled", Category: "onboarding", Description: "Tenant switch for the \"first recovered run\" onboarding checklist banner. Defaults to true so the guided flow is on; set false to hide the banner for this org (e.g. once the team is past onboarding). Disabling makes GET /onboarding skip all milestone derivation and return a hidden state \u2014 flipping it back on resumes from the org's derived progress.", ValueType: "boolean", Default: true},
}

func contains(values []string, want string) bool {
	return slices.Contains(values, want)
}

// trimFloat renders bounds without a trailing .0 so messages match the
// contract's JS number formatting.
func trimFloat(v float64) string {
	if v == float64(int64(v)) {
		return fmt.Sprintf("%d", int64(v))
	}
	return strings.TrimRight(fmt.Sprintf("%f", v), "0")
}

var byKey = func() map[string]*Definition {
	index := make(map[string]*Definition, len(Definitions))
	for i := range Definitions {
		index[Definitions[i].Key] = &Definitions[i]
	}
	return index
}()

// Get returns the definition for a key, or nil for an unknown key.
func Get(key string) *Definition { return byKey[key] }

// Normalize runs the contract's standard validation pipeline over a raw
// JSON-decoded value and returns the normalized typed value.
func Normalize(def *Definition, value any) (any, error) {
	validate := func(normalized any) (any, error) {
		if def.Validate != nil {
			if err := def.Validate(normalized); err != nil {
				return nil, err
			}
		}
		return normalized, nil
	}
	switch def.ValueType {
	case "boolean":
		typed, ok := value.(bool)
		if !ok {
			return nil, fmt.Errorf("%s must be a boolean", def.Key)
		}
		return validate(typed)
	case "number":
		typed, ok := value.(float64)
		if !ok || math.IsNaN(typed) || math.IsInf(typed, 0) {
			return nil, fmt.Errorf("%s must be a finite number", def.Key)
		}
		normalized := typed
		if !def.Fractional {
			normalized = math.Floor(typed)
		}
		if def.Min != nil && normalized < *def.Min {
			return nil, fmt.Errorf("%s must be >= %s", def.Key, trimFloat(*def.Min))
		}
		if def.Max != nil && normalized > *def.Max {
			return nil, fmt.Errorf("%s must be <= %s", def.Key, trimFloat(*def.Max))
		}
		return validate(normalized)
	default:
		typed, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("%s must be a string", def.Key)
		}
		normalized := strings.TrimSpace(typed)
		if normalized == "" {
			if def.AllowEmpty {
				return validate("")
			}
			return nil, fmt.Errorf("%s must be a non-empty string", def.Key)
		}
		if ForbiddenValuePattern.MatchString(normalized) {
			return nil, fmt.Errorf("%s must not contain secret-like values", def.Key)
		}
		if len(def.AllowedValues) > 0 && !contains(def.AllowedValues, normalized) {
			return nil, fmt.Errorf("%s must be one of: %s", def.Key, strings.Join(def.AllowedValues, ", "))
		}
		return validate(normalized)
	}
}

func validateAIOperatorGuidance(value any) error {
	text, ok := value.(string)
	if !ok {
		return fmt.Errorf("ai.operatorGuidance must be a string")
	}
	if len(text) > aiguidance.ScopeMaxBytes {
		return fmt.Errorf("ai.operatorGuidance exceeds 8 KiB cap")
	}
	if aiguidance.ContainsGuidanceSecret(text) {
		return fmt.Errorf("ai.operatorGuidance must not contain secret-like values")
	}
	return nil
}

func validateAnthropicModelID(value any) error {
	text, ok := value.(string)
	if !ok {
		return fmt.Errorf("ai.anthropic.model must be a string")
	}
	if _, valid := ai.NormalizeModelID(text); !valid {
		return fmt.Errorf("ai.anthropic.model must be a lowercase Anthropic model id of at most %d bytes", ai.MaxModelIDBytes)
	}
	return nil
}

var embeddingModelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]*$`)

func validateEmbeddingModel(value any) error {
	text, ok := value.(string)
	if !ok {
		return fmt.Errorf("memory.embeddingModel must be a string")
	}
	if text == "" {
		return nil
	}
	if len(text) > 256 || !embeddingModelPattern.MatchString(text) {
		return fmt.Errorf("memory.embeddingModel must be a model id of at most 256 bytes")
	}
	return nil
}

func validateEmbeddingBaseURL(value any) error {
	text, ok := value.(string)
	if !ok {
		return fmt.Errorf("memory.embeddingBaseUrl must be a string")
	}
	if text == "" {
		return nil
	}
	if len(text) > 2048 {
		return fmt.Errorf("memory.embeddingBaseUrl must be at most 2048 bytes")
	}
	parsed, err := url.Parse(text)
	if err != nil || parsed == nil || !parsed.IsAbs() || parsed.Host == "" || parsed.User != nil ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("memory.embeddingBaseUrl must be an absolute HTTP(S) base URL without credentials, query, or fragment")
	}
	return nil
}

func validateMemoryAllowedKinds(value any) error {
	text, ok := value.(string)
	if !ok {
		return fmt.Errorf("memory.allowedKinds must be a string")
	}
	for entry := range strings.SplitSeq(text, ",") {
		kind := strings.TrimSpace(entry)
		if kind != "" && !memorypolicy.IsKind(kind) {
			return fmt.Errorf("memory.allowedKinds entry %q is not one of: %s", kind, strings.Join(memorypolicy.Kinds(), ", "))
		}
	}
	return nil
}

func validateMemoryRetentionDaysByKind(value any) error {
	text, ok := value.(string)
	if !ok {
		return fmt.Errorf("memory.retentionDaysByKind must be a string")
	}
	if text == "" {
		return nil
	}
	var parsed any
	if json.Unmarshal([]byte(text), &parsed) != nil {
		return fmt.Errorf("memory.retentionDaysByKind must be valid JSON")
	}
	entries, ok := parsed.(map[string]any)
	if !ok {
		return fmt.Errorf("memory.retentionDaysByKind must be a JSON object")
	}
	for kind, rawDays := range entries {
		if !memorypolicy.IsKind(kind) {
			return fmt.Errorf("memory.retentionDaysByKind key %q is not one of: %s", kind, strings.Join(memorypolicy.Kinds(), ", "))
		}
		days, ok := rawDays.(float64)
		if !ok || math.Trunc(days) != days || days <= 0 {
			return fmt.Errorf("memory.retentionDaysByKind[%q] must be a positive integer", kind)
		}
		maximum, _ := memorypolicy.MaximumRetentionDays(kind)
		if days > float64(maximum) {
			return fmt.Errorf("memory.retentionDaysByKind[%q] must be <= %d", kind, maximum)
		}
	}
	return nil
}

func validateRecoverySLAPolicies(value any) error {
	text, ok := value.(string)
	if !ok {
		return fmt.Errorf("recovery.slaPolicies must be a string")
	}
	if text == "" {
		return nil
	}
	var parsed any
	if json.Unmarshal([]byte(text), &parsed) != nil {
		return fmt.Errorf("recovery.slaPolicies must be valid JSON")
	}
	entries, ok := parsed.(map[string]any)
	if !ok {
		return fmt.Errorf("recovery.slaPolicies must be a JSON object")
	}
	for severity, rawMinutes := range entries {
		if !domain.RecoveryItemSeverities[severity] {
			return fmt.Errorf("recovery.slaPolicies key %q is not one of: p1, p2, p3, p4", severity)
		}
		minutes, ok := rawMinutes.(float64)
		if !ok || math.Trunc(minutes) != minutes {
			return fmt.Errorf("recovery.slaPolicies[%q] must be an integer number of minutes", severity)
		}
		if minutes < 1 || minutes > 43_200 {
			return fmt.Errorf("recovery.slaPolicies[%q] must be between 1 and 43200 minutes", severity)
		}
	}
	return nil
}
