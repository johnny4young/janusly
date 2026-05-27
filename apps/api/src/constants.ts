/**
 * Cross-cutting numeric constants for the API surface. Three categories:
 *
 * - `HTTP_CAPS` — byte / character caps on user-visible HTTP payloads.
 * - `RATE_LIMIT_WINDOW_MS` + `RATE_LIMIT_DEFAULTS_PER_MIN` — shared
 *   rate-limiter window plus per-bucket default ceilings when no
 *   `org_configs` override is set.
 * - `TOLERANCE_WINDOWS_SEC` — external-signature timestamp tolerances
 *   plus session-TTL range bounds.
 *
 * Sibling to `api-config.ts` — that file is for runtime-resolved env
 * config (`process.env.*` reads); this file is for compile-time literals
 * shared across multiple call sites. Domain-specific constants that
 * already live alongside their consumers (e.g. `SANDBOX_DEFAULT_LIFETIME_MS`
 * in `mcp-sandbox.ts`, `MAX_TEMPLATE_BYTES` in `pdf-renderer.ts`) stay
 * where they are — moving them would split cohesion with their consumer
 * code for marginal centralization benefit.
 *
 * Used by API routes that call `enforceRateLimit` (the window + bucket
 * defaults), the WorkOS webhook (signature tolerance), and the reports
 * route (Slack block char cap). Do not import this module from
 * `packages/*`; package-owned validators keep local bounds until a shared
 * package-level constants module exists.
 */

/** Byte / character caps on user-visible HTTP payloads where the cap is
 *  centralized at the API surface rather than a domain-specific consumer. */
export const HTTP_CAPS = {
  /** 2500 chars — Slack message-block per-block cap (Slack API hard limit
   *  for `mrkdwn` blocks in incoming webhooks). */
  SLACK_BLOCK_CHARS: 2500,
} as const

/** Shared 1-minute rolling window for `enforceRateLimit`. All API-side
 *  callers use this window today; centralizing here means a future
 *  global tuning is a one-line change instead of a 10-file sweep. */
export const RATE_LIMIT_WINDOW_MS = 60_000 as const

/** Per-minute fallback defaults for the Redis-backed rate limiter, keyed
 *  by bucket family. Org-level overrides go through
 *  `org_configs.<family>.rateLimitPerMin`; these defaults apply only when
 *  no org config is present (or when the route hardcodes its own cap
 *  alongside the org-config read). */
export const RATE_LIMIT_DEFAULTS_PER_MIN = {
  /** AI-route fallback — used by recovery dialog when no org config. */
  ai: 30,
  /** MCP rediscover button. */
  mcpRediscover: 10,
  /** Auto-healing operator action. */
  autoHealingDecide: 30,
  /** Recovery dialog cluster-apply / per-row replay. */
  recovery: 120,
} as const

/** Tolerance windows in seconds for external-signature verification
 *  and ephemeral state. */
export const TOLERANCE_WINDOWS_SEC = {
  /** ±5 min — Stripe-style webhook signature timestamp skew tolerance.
   *  Receivers reject signatures whose `t=<unix-seconds>` is more than
   *  this many seconds from the receiver's current time. */
  WEBHOOK_SIGNATURE: 300,
  /** 10 min — WorkOS SSO state-token TTL. Set on
   *  `GET /auth/sso/start`, verified on the callback. */
  SSO_STATE_TOKEN: 600,
  /** 5 min — minimum session-token TTL an admin can configure. */
  SESSION_TTL_MIN: 300,
  /** 24 hours — maximum session-token TTL an admin can configure. */
  SESSION_TTL_MAX: 86_400,
  /** 8 hours — default session-token TTL when no admin override. */
  SESSION_TTL_DEFAULT: 28_800,
} as const
