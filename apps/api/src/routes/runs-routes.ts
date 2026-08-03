/**
 * Stable run-route registry.
 *
 * Route order is protocol behavior because matching is first-wins. Keep the
 * stream matcher before the broad `/runs` list matcher, keep comparison paths
 * excluded from that broad matcher, and preserve the remaining composition.
 */

import type { Route } from "../routes";
import { runDiagnosticRoutes } from "./run-routes/diagnostics";
import { runLifecycleRoutes } from "./run-routes/lifecycle";
import { runReadRoutes } from "./run-routes/reads";
import { runRedriveRoutes } from "./run-routes/redrive";
import { replayLabRoutes } from "./run-routes/replay-lab";
import { runStreamRoutes } from "./run-routes/stream";

export const runsRoutes: Route[] = [
  ...runStreamRoutes,
  ...runReadRoutes,
  ...runRedriveRoutes,
  ...runLifecycleRoutes,
  ...replayLabRoutes,
  ...runDiagnosticRoutes,
];
