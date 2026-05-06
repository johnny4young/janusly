/**
 * Recovery-matrix fixtures — the catalog of distinct failure shapes the
 * multi-suggestion patch route is exercised against. Single source of
 * truth for two consumers:
 *
 *   - `apps/api/src/ai-patch-multi-suggestion.matrix.test.ts` —
 *     parametrised tests with a mocked LlmClient. Pins per-fixture
 *     validation, post-merge structural diff, and audit metadata.
 *   - `scripts/seed-recovery-matrix.ts` — dev seeder that inserts the
 *     prerequisite `workflow_versions` / `runs` / `run_nodes` /
 *     `run_events` / `dead_letters` rows so an operator can drive the
 *     real Recovery dialog through every shape during a manual UI smoke.
 *
 * The catalog covers HTTP failure modes (404 typo / 500 transient / 401
 * auth / body cap / redirect loop / timeout), tool input errors, missing
 * secrets, AI provider transients, and write-side without-approval flags.
 * Each fixture declares an `expectedTopApproachLabel` — the dominant
 * `approachLabel` the LLM would reasonably pick for that shape — used as
 * an observability target across the matrix (not a hard gate, since the
 * raw self-rated confidence isn't calibrated yet).
 */

import type { Workflow } from "@janusly/shared";
import type { AiPatchApproachLabelValue } from "./ai-schemas";

export type RecoveryMatrixFixture = {
  /** Stable fixture id used as the workflow/run id suffix by the dev seeder. */
  id: string;
  /** Short human-friendly name surfaced in the seeder log + matrix test output. */
  label: string;
  /** Workflow snapshot the failing node lives in. Stored verbatim into `workflow_versions.dag_json`. */
  workflow: Workflow;
  /** Id of the node inside `workflow.nodes` that we treat as failed. */
  failedNodeId: string;
  /** Persisted error envelope (already key-redacted shape, mirrors what `safe-persist` writes). */
  errorJson: Record<string, unknown>;
  /** Most-likely approachLabel for this failure shape — used as observability target. */
  expectedTopApproachLabel: AiPatchApproachLabelValue;
  /** Free-text seed-script log line so the operator can trace fixtures end-to-end. */
  description: string;
};

const httpNode = (id: string, config: Record<string, unknown>) => ({
  id,
  type: "http" as const,
  config,
});

const toolNode = (id: string, config: Record<string, unknown>) => ({
  id,
  type: "tool" as const,
  config,
});

const wf = (id: string, name: string, nodes: Workflow["nodes"], edges: Workflow["edges"] = []): Workflow => ({
  dslVersion: "1.0",
  id,
  name,
  nodes,
  edges,
});

/**
 * Catalog of 10 failure shapes covering the recovery surface. Order is
 * stable — both the matrix test and the seed script iterate this array
 * in declaration order so log output and test-case names align.
 */
export const RECOVERY_MATRIX_FIXTURES: readonly RecoveryMatrixFixture[] = [
  {
    id: "http_404_typo",
    label: "HTTP 404 typo URL",
    description: "Operator typed the URL wrong — `https://api.example/typoo` instead of `/typo`.",
    workflow: wf("recovery_matrix_http_404_typo", "Recovery Matrix · HTTP 404 typo", [
      httpNode("fetch", { url: "https://api.example/typoo", method: "GET" }),
    ]),
    failedNodeId: "fetch",
    errorJson: {
      code: "E_HTTP_STATUS",
      message: "HTTP 404 from upstream",
      status: 404,
      url: "https://api.example/typoo",
    },
    expectedTopApproachLabel: "fix_url",
  },

  {
    id: "http_500_transient",
    label: "HTTP 500 transient",
    description: "Upstream returned 500 once; classic retryable transient.",
    workflow: wf("recovery_matrix_http_500_transient", "Recovery Matrix · HTTP 500 transient", [
      httpNode("fetch", { url: "https://api.example/orders", method: "GET" }),
    ]),
    failedNodeId: "fetch",
    errorJson: {
      code: "E_HTTP_STATUS",
      message: "HTTP 500 Internal Server Error",
      status: 500,
      url: "https://api.example/orders",
    },
    expectedTopApproachLabel: "add_retry",
  },

  {
    id: "http_401_literal_token",
    label: "HTTP 401 auth missing",
    description: "Authorization header has a literal token; should be a {{secret.NAME}} reference.",
    workflow: wf("recovery_matrix_http_401_literal_token", "Recovery Matrix · HTTP 401 literal token", [
      httpNode("fetch", {
        url: "https://api.example/private",
        method: "GET",
        headers: { Authorization: "Bearer hardcoded-token-DO-NOT-COMMIT" },
      }),
    ]),
    failedNodeId: "fetch",
    errorJson: {
      code: "E_HTTP_STATUS",
      message: "HTTP 401 unauthorized — token rejected by upstream",
      status: 401,
      url: "https://api.example/private",
    },
    expectedTopApproachLabel: "swap_secret_ref",
  },

  {
    id: "http_body_cap",
    label: "HTTP body cap exceeded",
    description: "Response body is 5 MB but the engine default is 1 MB; raise maxResponseBytes.",
    workflow: wf("recovery_matrix_http_body_cap", "Recovery Matrix · HTTP body cap", [
      httpNode("fetch", { url: "https://api.example/large-export", method: "GET" }),
    ]),
    failedNodeId: "fetch",
    errorJson: {
      code: "E_HTTP_BODY_CAP",
      message: "Response body exceeded maxResponseBytes (1048576)",
      bytes: 5_242_880,
      maxResponseBytes: 1_048_576,
      url: "https://api.example/large-export",
    },
    expectedTopApproachLabel: "other",
  },

  {
    id: "http_redirect_loop",
    label: "HTTP redirect loop",
    description: "Upstream redirects past the default cap of 5; raise maxRedirects.",
    workflow: wf("recovery_matrix_http_redirect_loop", "Recovery Matrix · HTTP redirect loop", [
      httpNode("fetch", { url: "https://api.example/legacy", method: "GET" }),
    ]),
    failedNodeId: "fetch",
    errorJson: {
      code: "E_HTTP_REDIRECT_LIMIT",
      message: "Exceeded maxRedirects (5)",
      maxRedirects: 5,
      url: "https://api.example/legacy",
    },
    expectedTopApproachLabel: "other",
  },

  {
    id: "http_timeout",
    label: "HTTP timeout",
    description: "Upstream responds in 60s but the engine default is 30s.",
    workflow: wf("recovery_matrix_http_timeout", "Recovery Matrix · HTTP timeout", [
      httpNode("fetch", { url: "https://api.example/slow-report", method: "GET" }),
    ]),
    failedNodeId: "fetch",
    errorJson: {
      code: "E_HTTP_TIMEOUT",
      message: "Request timed out after 30000ms",
      timeoutMs: 30000,
      url: "https://api.example/slow-report",
    },
    expectedTopApproachLabel: "raise_timeout",
  },

  {
    id: "tool_input_invalid",
    label: "Tool input invalid",
    description: "`text.replace` tool got malformed input — missing required field.",
    workflow: wf("recovery_matrix_tool_input_invalid", "Recovery Matrix · Tool input invalid", [
      toolNode("transform", {
        tool: "text.replace",
        input: { input: "{{context.fetch.output.body}}" }, // Missing `pattern` and `replacement`.
      }),
    ]),
    failedNodeId: "transform",
    errorJson: {
      code: "E_TOOL_INPUT_INVALID",
      message: "Tool 'text.replace' input failed schema validation: pattern is required, replacement is required",
      tool: "text.replace",
    },
    expectedTopApproachLabel: "other",
  },

  {
    id: "missing_secret_template",
    label: "Missing secret template",
    description: "Workflow references {{secret.STRIPE_KEY}} but the secret isn't bound.",
    workflow: wf("recovery_matrix_missing_secret_template", "Recovery Matrix · Missing secret template", [
      httpNode("fetch", {
        url: "https://api.example/charges",
        method: "POST",
        headers: { Authorization: "Bearer {{secret.STRIPE_KEY}}" },
      }),
    ]),
    failedNodeId: "fetch",
    errorJson: {
      code: "E_SECRET_MISSING",
      message: "Secret 'STRIPE_KEY' is not bound to this org",
      secret: "STRIPE_KEY",
    },
    expectedTopApproachLabel: "swap_secret_ref",
  },

  {
    id: "ai_provider_transient",
    label: "AI provider transient",
    description: "AI provider returned 429 once; the call is fundamentally retryable.",
    workflow: wf("recovery_matrix_ai_provider_transient", "Recovery Matrix · AI provider transient", [
      {
        id: "summarize",
        type: "ai",
        config: { prompt: "Summarize the article in 2 sentences." },
      },
    ]),
    failedNodeId: "summarize",
    errorJson: {
      code: "E_AI_PROVIDER",
      message: "Anthropic 429: rate-limit exceeded",
      provider: "anthropic",
    },
    expectedTopApproachLabel: "add_retry",
  },

  {
    id: "write_side_without_approval",
    label: "Write-side without approval",
    description: "POST to a payments endpoint without an upstream approval node — readiness flagged it.",
    workflow: wf("recovery_matrix_write_side_without_approval", "Recovery Matrix · Write-side without approval", [
      httpNode("charge", { url: "https://api.example/charges", method: "POST" }),
    ]),
    failedNodeId: "charge",
    errorJson: {
      code: "E_READINESS_FAIL",
      message: "Write-side action requires an upstream approval node (POST /charges)",
      readinessCode: "write_side_missing_approval",
    },
    expectedTopApproachLabel: "add_approval",
  },
] as const;
