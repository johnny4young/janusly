/**
 * Side-effect-free stable API contracts for the ai domain.
 * Imported by route registries and the pure OpenAPI manifest.
 */

import { V1_WRITE_PATHS } from "@janusly/shared/src/api-contract";

import type { ApiRouteContract } from "../api-contract-types";
import {
  GenerateWorkflowBodySchema,
  GenerateWorkflowResponseSchema,
  PatchWorkflowBodySchema,
  PatchWorkflowResponseSchema,
} from "./schemas";

export const generateWorkflowContract = {
  operationId: "generateWorkflow",
  path: V1_WRITE_PATHS.generateWorkflow,
  summary: "Generate a validated workflow draft from an operator prompt",
  tags: ["AI"],
  request: { body: GenerateWorkflowBodySchema },
  response: GenerateWorkflowResponseSchema,
  errorCodes: ["invalid_input", "ai_prompt_too_long", "budget_exceeded"],
} satisfies ApiRouteContract;

export const patchWorkflowContract = {
  operationId: "patchWorkflow",
  path: V1_WRITE_PATHS.patchWorkflow,
  summary: "Suggest bounded recovery patches for one dead letter",
  tags: ["AI", "Recovery"],
  request: { body: PatchWorkflowBodySchema },
  response: PatchWorkflowResponseSchema,
  errorCodes: [
    "invalid_input",
    "ai_dead_letter_id_required",
    "ai_run_not_found",
    "dlq_not_found",
    "budget_exceeded",
  ],
} satisfies ApiRouteContract;
