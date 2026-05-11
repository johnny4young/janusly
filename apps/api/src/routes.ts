/**
 * Route registry types for `apps/api/src/server.ts`.
 *
 * The api server dispatches each request against the `routes: Route[]` array
 * exported from `index.ts`. New routes plug in via `routes.push({...})` (or by
 * appending to the literal at source); the dispatcher loop in `server.ts` is
 * closed for modification.
 *
 * Used by `apps/api/src/server.ts` (the dispatcher) and by every feature that
 * adds an HTTP route.
 *
 * Invariants:
 * - First match wins. The dispatcher iterates `routes` in order; preserve the
 *   ordering when refactoring or adding routes that overlap (e.g. `/runs`
 *   prefix vs `/run?` exact).
 * - `requireAuth` and `requireRole` run in the dispatcher, NOT inside
 *   handlers — handlers receive `auth` already-validated. Only `/health`
 *   sets `skipAuth: true`.
 * - Multi-tenant scope still lives inside each handler (per AGENTS.md). The
 *   dispatcher only handles auth + RBAC; per-row org checks (`run.orgId !==
 *   auth.orgId`) stay in the handler.
 */

import type http from "http";
import type { AuthContext } from "./auth";
import type { Role } from "./permissions";
import type { CorsAwareResponse } from "./http";

/** Either an exact-string URL match or a predicate function over the URL. */
export type RouteMatch = string | ((url: string) => boolean);

/** Per-request context handed to every route handler. */
export type RouteContext = {
  req: http.IncomingMessage;
  res: CorsAwareResponse;
  /** Resolved auth context. The dispatcher casts to `AuthContext` after
   * `requireAuth`; for `skipAuth` routes the cast is unsafe but only
   * `/health` opts out and its handler doesn't read the field. */
  auth: AuthContext;
};

/** One registered HTTP route. */
export type Route = {
  method: "GET" | "POST" | "DELETE";
  match: RouteMatch;
  /** When true, skip `requireAuth`. Only `/health` should set this. */
  skipAuth?: boolean;
  /** Required role checked after `requireAuth`. Omit for viewer-or-above. */
  role?: Role;
  /** Handler runs after auth + RBAC; writes the response itself. */
  handler: (ctx: RouteContext) => Promise<unknown>;
};

/** True when the URL satisfies the route's match shape (string or predicate). */
export function matchesRoute(match: RouteMatch, url: string): boolean {
  return typeof match === "string" ? url === match : match(url);
}
