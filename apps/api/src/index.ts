/**
 * Janusly API — plain Node `http.createServer` with a typed route registry.
 * No Express, no Fastify, no tRPC (the tRPC stub is intentionally deleted
 * per AGENTS.md; don't reintroduce it).
 *
 * Boot sequence:
 *   1. Compose the global `routes` array from the per-surface modules
 *      under `apps/api/src/routes/*`. Order matters — the dispatcher in
 *      `server.ts` is first-match-wins; preserve module order when adding
 *      new surfaces.
 *   2. Build the http server via `createApiServer({ routes, timeouts })`.
 *   3. `assertMigrationsApplied()` — fail-fast on an unmigrated DB.
 *   4. Register process-global recorders + the engine rate-limit DI seam
 *      (telemetry chokepoint for LLM, email, integration, and PDF tools).
 *   5. Wire SIGTERM/SIGINT to drain HTTP connections, then `server.listen`.
 *
 * Per-request: route registry match → `requireAuth` → route-declared
 * `requireRole` → handler. Handlers see `auth: AuthContext` already
 * validated.
 *
 * Used by `apps/web` (the only browser client today) and any external
 * caller that respects dev headers or the Supabase JWT auth.
 *
 * Invariants:
 * - Multi-tenant: every DB query in a route handler passes
 *   `eq(<table>.orgId, auth.orgId)`. The dispatcher only handles auth +
 *   RBAC; per-row scope stays in the handler per AGENTS.md.
 * - Pagination cap: `GET /runs` and `GET /workflows` cap at 100/200
 *   rows (`?limit=` opt-in). `GET /run` and `GET /status` cap nested
 *   events at 200/500 with a composite cursor.
 * - Rate limiter: AI surfaces gate on Redis-backed `enforceRateLimit`
 *   (fails open with `[rate-limit]` warn on Redis errors).
 * - Audit logs: every mutation writes a row with a stable `action`
 *   string; AI mutations write audit on success AND on fallback.
 */

import { setUsageRecorder } from "@janusly/ai";
import { recordEmailUsage, recordIntegrationUsage, recordMcpUsage, recordMemoryUsage, recordPdfUsage, recordUsage } from "@janusly/data/src/usageRepo";
import { setMemoryUsageRecorder } from "@janusly/data/src/memoryUsage";
import { assertMigrationsApplied } from "@janusly/db/src/migrations";
import { setEmailUsageRecorder } from "@janusly/engine/src/email-usage";
import { setIntegrationUsageRecorder } from "@janusly/engine/src/integration-usage";
import { setMcpUsageRecorder } from "@janusly/engine/src/mcp-usage";
import { setPdfUsageRecorder } from "@janusly/engine/src/pdf-usage";
import { setEngineRateLimiter } from "@janusly/engine/src/rate-limit";
import { setBudgetChecker } from "@janusly/engine/src/budget";
import { productionBudgetChecker } from "@janusly/data/src/budgetRepo";
// Side-effect import — registers the `subworkflow` node type with the
// engine's node registry. Without this, workflows that include a
// `subworkflow` node throw "Unknown node type" at execute time.
import "@janusly/engine/src/subworkflow";

import {
  API_HEADERS_TIMEOUT_MS,
  API_KEEP_ALIVE_TIMEOUT_MS,
  API_REQUEST_TIMEOUT_MS,
  API_SHUTDOWN_GRACE_MS,
  PORT,
} from "./api-config";
import { enforceRateLimit } from "./rate-limit";
import type { Route } from "./routes";
import { aiRoutes } from "./routes/ai-routes";
import { auditRoutes } from "./routes/audit-routes";
import { billingRoutes } from "./routes/billing-routes";
import { credentialsRoutes } from "./routes/credentials-routes";
import { dlqRoutes } from "./routes/dlq-routes";
import { healthRoutes } from "./routes/health-routes";
import { mcpRoutes } from "./routes/mcp-routes";
import { membersRoutes } from "./routes/members-routes";
import { orgRoutes } from "./routes/org-routes";
import { rolesRoutes } from "./routes/roles-routes";
import { scimRoutes } from "./routes/scim-routes";
import { ssoRoutes } from "./routes/sso-routes";
import { pluginsRoutes } from "./routes/plugins-routes";
import { promptsRoutes } from "./routes/prompts-routes";
import { recoveryRoutes } from "./routes/recovery-routes";
import { reportsRoutes } from "./routes/reports-routes";
import { runsRoutes } from "./routes/runs-routes";
import { templatesRoutes } from "./routes/templates-routes";
import { toolsRoutes } from "./routes/tools-routes";
import { workflowsRoutes } from "./routes/workflows-routes";
import { createApiServer } from "./server";

/**
 * Composed route registry. Module order matters — the dispatcher is
 * first-match-wins; this order mirrors the original monolithic literal
 * so overlap-sensitive pairs (`/workflows/versions` before
 * `/workflows`, `/workflows/health/delta` before `/workflows/health`,
 * `/runs` prefix before `/run?` exact, `/dlq/clusters` before `/dlq`
 * wildcard) keep their precedence.
 */
export const routes: Route[] = [
  ...healthRoutes,
  ...toolsRoutes,
  ...templatesRoutes,
  ...billingRoutes,
  ...orgRoutes,
  ...membersRoutes,
  ...ssoRoutes,
  ...scimRoutes,
  ...rolesRoutes,
  ...mcpRoutes,
  ...workflowsRoutes,
  ...pluginsRoutes,
  ...credentialsRoutes,
  ...promptsRoutes,
  ...auditRoutes,
  ...recoveryRoutes,
  ...reportsRoutes,
  ...aiRoutes,
  ...runsRoutes,
  ...dlqRoutes,
];

const server = createApiServer({
  routes,
  timeouts: {
    requestTimeoutMs: API_REQUEST_TIMEOUT_MS,
    keepAliveTimeoutMs: API_KEEP_ALIVE_TIMEOUT_MS,
    headersTimeoutMs: API_HEADERS_TIMEOUT_MS,
  },
});

await assertMigrationsApplied();

// Register the usage_events writer once at boot. Every LLM client call fires
// it fire-and-forget through the provider-neutral AI package.
setUsageRecorder(recordUsage);

// Inject the Redis-backed rate limiter into the engine for write-side
// tools (today: `email.send`, `pdf.generate`, integration tools). The
// engine can't import from `apps/api` directly without inverting the
// dependency graph; this DI seam is the bridge. Adapter shape: the
// engine signs `(bucket, orgId, options)` while `enforceRateLimit`
// expects `(key, { name, windowMs, max })` — the bucket name namespaces
// the Redis key, `orgId` is the per-tenant counter key. Same fail-open
// Redis-blip behavior as the LLM rate gate.
setEngineRateLimiter(async (bucket, orgId, options) => {
  await enforceRateLimit(orgId, { name: bucket, windowMs: options.windowMs, max: options.max });
});

// Mirror of `setUsageRecorder` for write-side tools. Every send /
// integration call / PDF render (success OR failure) writes a
// `usage_events` row with a tool-specific `metric`, surfacing in the
// existing `?breakdown=workflow,provider` UI without changes.
setEmailUsageRecorder(recordEmailUsage);
setIntegrationUsageRecorder(recordIntegrationUsage);
setMcpUsageRecorder(recordMcpUsage);
setPdfUsageRecorder(recordPdfUsage);
setMemoryUsageRecorder(recordMemoryUsage);

// Wire the production AI cost budget checker. Every LLM call site
// (6 /ai/* routes + 3 engine paths) gates through this checker before
// firing. Fail-soft posture: the checker (and the chokepoint wrapper)
// return allowed=true / no-limit on any internal error so a Redis or DB
// blip never breaks AI Studio. Documented in AGENTS.md alongside the
// rate-limit fail-open invariant.
setBudgetChecker(productionBudgetChecker);
console.log("[budget] checker registered (api)");

let shutdownStarted = false;

async function shutdownApi(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;

  console.log(`[api] received ${signal}; draining HTTP connections`);
  const forceCloseTimer = setTimeout(() => {
    console.warn("[api] graceful shutdown timed out; closing active connections");
    server.closeAllConnections();
  }, API_SHUTDOWN_GRACE_MS);
  forceCloseTimer.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    clearTimeout(forceCloseTimer);
    console.log("[api] HTTP server stopped");
    process.exit(0);
  } catch (err) {
    clearTimeout(forceCloseTimer);
    console.error("[api] HTTP shutdown failed", err);
    process.exit(1);
  }
}

process.once("SIGTERM", (signal) => {
  void shutdownApi(signal);
});
process.once("SIGINT", (signal) => {
  void shutdownApi(signal);
});

server.listen(PORT, () => console.log(`API running on port ${PORT}`));
