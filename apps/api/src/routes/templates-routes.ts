/**
 * Workflow template catalog. Returns the static template list shipped
 * in `apps/api/src/templates.ts`. Read-only, any role.
 */

import { sendJson } from "../http";
import type { Route } from "../routes";
import { workflowTemplates } from "../templates";

export const templatesRoutes: Route[] = [
  { method: "GET", match: "/templates",
    handler: async ({ res }) => sendJson(res, workflowTemplates) },
];
