/**
 * Side-effect-free stable API contracts for the catalog domain.
 * Imported by route registries and the pure OpenAPI manifest.
 */

import { V1_READ_PATHS } from "@janusly/shared/src/api-contract";
import { z } from "zod";

import type { ApiRouteContract } from "../api-contract-types";
import { PublicToolSchema, WorkflowTemplateSchema } from "./schemas";

export const listTemplatesContract = {
  operationId: "listTemplates",
  path: V1_READ_PATHS.templates,
  summary: "List built-in workflow recipes",
  tags: ["Catalogs"],
  response: z.array(WorkflowTemplateSchema),
  errorCodes: [],
} satisfies ApiRouteContract;

export const listToolsContract = {
  operationId: "listTools",
  path: V1_READ_PATHS.tools,
  summary: "List workflow runtime tools and their input fields",
  tags: ["Catalogs"],
  response: z.array(PublicToolSchema),
  errorCodes: [],
} satisfies ApiRouteContract;
