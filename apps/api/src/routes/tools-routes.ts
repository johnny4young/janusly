/**
 * Tool registry catalog. Returns the AI-Studio-facing
 * `listTools()` JSON shape (`name` / `description` / `required` /
 * `optional` / `inputExample`). Field names are part of the public
 * contract `apps/web` reads via `ToolSchema`; do not drift.
 */

import { listTools } from "@janusly/engine/src/tool-registry";

import { sendJson } from "../http";
import type { Route } from "../routes";

export const toolsRoutes: Route[] = [
  { method: "GET", match: "/tools",
    handler: async ({ res }) => sendJson(res, listTools()) },
];
