/** Public route for the generated OpenAPI 3.1 document. */

import { V1_CONTRACT_ROUTES } from "./api-contracts";
import { sendJson } from "./http";
import { buildOpenApiDocument } from "./openapi";
import type { Route } from "./routes";

export const openApiRoutes: Route[] = [
  {
    method: "GET",
    match: "/v1/openapi.json",
    skipAuth: true,
    handler: async ({ res }) => sendJson(res, buildOpenApiDocument(V1_CONTRACT_ROUTES)),
  },
];
