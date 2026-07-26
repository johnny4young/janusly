/**
 * Workflow template catalog. Returns the static template list shipped
 * in `apps/api/src/templates.ts`. Read-only, any role.
 *
 * Each entry is decorated with stable `nameCode` / `descriptionCode` /
 * `categoryCode` fields so the web layer can translate via the i18n
 * catalog. The English literals stay on the wire as the fallback the
 * client uses when no translation key is mirrored yet.
 */

import { listTemplatesContract } from "../api-contracts";
import { sendJson } from "../http";
import type { Route } from "../routes";
import { asPublicTemplate, workflowTemplates } from "../templates";

export const templatesRoutes: Route[] = [
  {
    method: "GET",
    match: "/templates",
    contract: listTemplatesContract,
    handler: async ({ res }) => sendJson(res, workflowTemplates.map(asPublicTemplate)),
  },
];
