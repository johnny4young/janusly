/**
 * Side-effect-free stable API contracts for the reports domain.
 * Imported by route registries and the pure OpenAPI manifest.
 */

import { V1_READ_PATHS } from "@janusly/shared/src/api-contract";
import { z } from "zod";

import type { ApiRouteContract } from "../api-contract-types";
import { RunExplainReportSchema } from "./schemas";

export const getRunExplainReportContract = {
  operationId: "getRunExplainReport",
  path: V1_READ_PATHS.runExplainReport,
  summary: "Get a structured deterministic explanation of one run",
  tags: ["Reports"],
  request: {
    query: z.object({
      runId: z.string().min(1).max(256),
      format: z.literal("json")
        .describe("The stable API exposes structured JSON only; downloadable artifacts remain on the legacy route."),
    }).strict(),
  },
  response: RunExplainReportSchema,
  errorCodes: ["invalid_input", "reports_run_not_found"],
} satisfies ApiRouteContract;
