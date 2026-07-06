/**
 * Public response DTOs for the Janusly typed client.
 *
 * Each type carries a JSDoc comment naming its source HTTP route. The DTOs
 * are hand-typed (not generated) so the SDK ships standalone — no shared
 * runtime dependency on `@janusly/shared` or `@janusly/db`.
 *
 * If the server adds a new field, the DTO doesn't break: TypeScript
 * structural typing accepts extra fields on values; the consumer just
 * doesn't see them through the typed surface. Removing or renaming a field
 * IS a breaking change — those are handled by the SDK's versioning story
 * (currently workspace-private v0.0.1).
 */

/**
 * Closed enum of run lifecycle statuses. Source: `apps/api`'s `runs.status`
 * column (`packages/db/src/schema.ts`).
 */
export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

/** Terminal statuses — `pollUntilTerminal` + `streamEvents` exit on these. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

/** Closed enum of per-node lifecycle statuses. */
export type RunNodeStatus =
  | "pending"
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

/**
 * Summary shape returned by `GET /runs` (list view) and the `run` field of
 * `GET /run` (detail view). Fields after `endedAt` are optional because the
 * list view omits them in older API versions.
 */
export type RunSummary = {
  id: string;
  status: RunStatus;
  workflowVersionId: string;
  /** Workflow display name when joined server-side. May be null for ad-hoc runs. */
  workflowName?: string | null;
  /**
   * Sandbox replay marker: `"validation"` for Replay Lab runs, `null` for
   * production runs. Documented in AGENTS.md under "Sandbox replay gate".
   */
  replayMode?: "validation" | null;
  /** Set for fork replays and subworkflow children. */
  parentRunId?: string | null;
  /** Set for selected-node forks (Replay Lab fork feature). */
  parentNodeId?: string | null;
  createdAt: string;
  startedAt?: string | null;
  endedAt?: string | null;
};

/** Single per-node status row from `GET /run`. */
export type RunNode = {
  nodeId: string;
  status: RunNodeStatus;
  /** Node-shaped state (input + output for that node). Redacted server-side. */
  stateJson?: Record<string, unknown> | null;
  /** Error envelope on `failed` nodes. */
  errorJson?: Record<string, unknown> | null;
  startedAt?: string | null;
  finishedAt?: string | null;
};

/** Single run-timeline event. */
export type RunEvent = {
  /** Stable event id — used as the secondary key in the cursor. */
  id: string;
  /** Event type, e.g. `"run.started"`, `"node.completed"`, `"mcp_tool.completed"`. */
  type: string;
  /** Per-node events carry the node id; run-level events omit it. */
  nodeId?: string | null;
  payload?: Record<string, unknown>;
  createdAt: string;
};

/**
 * Detail shape returned by `GET /run?runId=…&eventsLimit=…&eventsCursor=…`.
 *
 * Events are returned oldest-first within each page. The cursor
 * `"<isoCreatedAt>|<eventId>"` points to the oldest item in the current page
 * so callers can request older history without skipping events that share a
 * millisecond timestamp.
 */
export type RunDetails = {
  run: RunSummary;
  nodes: RunNode[];
  events: RunEvent[];
  eventsHasMore: boolean;
  eventsCursor: string | null;
};

/**
 * Severity bands the server emits with each recovery metric. Mirrors the
 * `MetricSeverity` type in `packages/engine/src/recovery-metrics.ts`.
 */
export type RecoveryMetricSeverity = "healthy" | "warn" | "alert" | "neutral";

/** Single recovery metric card shape. */
export type RecoveryMetric = {
  value: number | null;
  display: string;
  severity: RecoveryMetricSeverity;
  rationale: string;
  /**
   * Stable identifier the web's i18n catalog uses to translate `rationale`.
   * Surfaced through the SDK verbatim in case integrators want to switch on
   * it.
   */
  rationaleCode: string;
  rationaleMeta?: Record<string, string | number | boolean>;
};

/** Single cost-provider row inside the `costThisWindow` metric. */
export type RecoveryCostProviderRow = {
  provider: string;
  costUsd: number;
  spendShare: number;
};

/** SLA-attainment card inside the recovery metrics payload. */
export type RecoverySlaAttainmentMetric = RecoveryMetric & {
  resolvedInWindow: number;
  metSla: number;
};

/** One per-day point of the MTTR trend sparkline. `day` is `YYYY-MM-DD`. */
export type RecoveryMttrTrendPoint = { day: string; seconds: number };

/** Response shape of `GET /recovery/metrics?windowDays=…`. */
export type RecoveryMetrics = {
  successRate: RecoveryMetric;
  mttr: RecoveryMetric;
  p95Latency: RecoveryMetric;
  approvalsPending: RecoveryMetric;
  replayRate: RecoveryMetric;
  slaAttainment: RecoverySlaAttainmentMetric;
  costThisWindow: RecoveryMetric & { providers: RecoveryCostProviderRow[] };
  windowDays: number;
  /** Total terminal runs in the window — denominator for downstream rollups. */
  terminalRuns: number;
  /** Per-day avg recovery time (last ≤14 days, oldest-first) for the MTTR trend sparkline; `[]` when nothing replayed. */
  mttrTrend: RecoveryMttrTrendPoint[];
  /** Total automation downtime closed in the window (ms) — summed recovery time of replayed failures; a measured figure. */
  downtimeEndedMs: number;
};

/**
 * Auth mode the `JanuslyClient` constructor accepts. Service-token mode is
 * the recommended posture for server-to-server callers; bearer mode is for
 * callers that already hold a Supabase JWT (or another bearer the API
 * recognises).
 */
export type JanuslyAuthMode =
  | {
      kind: "service-token";
      /** The shared service-token value (matches `JANUSLY_API_SERVICE_TOKEN`). */
      token: string;
      /**
       * Identity claim sent as `x-user-id`. Defaults to `"sdk-user"` — set this
       * to distinguish per-integration audit-log actor ids.
       */
      userId?: string;
    }
  | {
      kind: "bearer";
      /** Any bearer the API resolves (Supabase JWT, etc.). */
      token: string;
    };

/** Optional retry layer config. Off by default for predictability. */
export type JanuslyRetryConfig = {
  /** Default 0 = no retries. Max recommended 5. */
  maxAttempts?: number;
  /** Initial backoff in ms; exponential: `backoff * 2^attempt`. Default 200. */
  backoffMs?: number;
  /** HTTP status codes that trigger a retry. Default `[429, 502, 503, 504]`. */
  retryOn?: number[];
};

/** Optional structured logger. Defaults to a no-op. */
export type JanuslyLogger = {
  debug?: (msg: string, meta?: Record<string, unknown>) => void;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
  error?: (msg: string, meta?: Record<string, unknown>) => void;
};

/** Constructor config for `JanuslyClient`. */
export type JanuslyClientConfig = {
  /** Base API URL, e.g. `https://api.janusly.com`. Trailing slashes stripped. */
  baseUrl: string;
  /** Always sent as the `x-org-id` header. Multi-tenant scope lives here. */
  orgId: string;
  auth: JanuslyAuthMode;
  /** Custom User-Agent suffix, e.g. `"acme-integrator/1.0"`. */
  userAgent?: string;
  /** Structured logger. Hooks fire on retries and unexpected response shapes. */
  logger?: JanuslyLogger;
  /** Opt-in retry layer. Default `{ maxAttempts: 0 }` = no retries. */
  retry?: JanuslyRetryConfig;
  /** Injectable fetch for tests / proxies. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
};

/** Per-call request options accepted by every method. */
export type JanuslyRequestOptions = {
  /** Abort the request (and any in-flight retry / poll cycle). */
  signal?: AbortSignal;
  /** Additional headers merged into the request (must not collide with SDK-managed headers). */
  headers?: Record<string, string>;
  /** Per-call timeout override. Defaults to 30s. */
  timeoutMs?: number;
};
