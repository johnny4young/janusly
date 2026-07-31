/**
 * Side-effect-free stable API contracts for the dlq domain.
 * Imported by route registries and the pure OpenAPI manifest.
 */

import { V1_READ_PATHS, V1_WRITE_PATHS } from "@janusly/shared/src/api-contract";
import { z } from "zod";

import type { ApiRouteContract } from "../api-contract-types";
import {
  DeadLetterSummarySchema,
  DlqSeveritySchema,
  DlqSortSchema,
  DlqStatusSchema,
  FailureClusterSchema,
  MCP_WRITE_ERROR_CODES,
  PositiveLimitSchema,
  ReplayDeadLetterBodySchema,
} from "./schemas";

export const listDeadLettersContract = {
  operationId: "listDeadLetters",
  path: V1_READ_PATHS.deadLetters,
  summary: "List bounded dead-letter summaries with recovery ownership state",
  tags: ["Recovery"],
  request: {
    query: z.object({
      status: DlqStatusSchema.optional(),
      severity: DlqSeveritySchema.optional(),
      sort: DlqSortSchema.optional(),
      owner: z.string().trim().min(1).max(200).optional(),
      search: z.string().trim().min(1).max(100).optional(),
      limit: PositiveLimitSchema.optional(),
    }).strict(),
  },
  response: z.array(DeadLetterSummarySchema),
  errorCodes: ["invalid_input"],
} satisfies ApiRouteContract;

export const listFailureClustersContract = {
  operationId: "listFailureClusters",
  path: V1_READ_PATHS.failureClusters,
  summary: "Group recent production failures by scrubbed normalized signature",
  tags: ["Recovery"],
  request: {
    query: z.object({
      windowDays: z.coerce.number().int().min(1).max(90).optional()
        .describe("Failure lookback window in days (1-90, default 30)."),
    }).strict(),
  },
  response: z.object({
    clusters: z.array(FailureClusterSchema),
    totalSamples: z.number().int().nonnegative(),
    windowDays: z.number().int().min(1).max(90),
  }).strict(),
  errorCodes: ["invalid_input"],
} satisfies ApiRouteContract;

export const replayDeadLetterContract = {
  operationId: "replayDeadLetter",
  path: V1_WRITE_PATHS.replayDeadLetter,
  summary: "Replay one dead letter through the generation-bound recovery claim path",
  tags: ["Recovery"],
  request: { body: ReplayDeadLetterBodySchema },
  response: z.object({ ok: z.literal(true) }).strict(),
  errorCodes: [
    "invalid_input",
    "dlq_not_found",
    "dlq_failing_node_missing",
    "dlq_node_mid_retry",
    "dlq_replay_conflict",
    "dlq_workflow_sanitize_failed",
    "recovery_playbook_outcome_invalid",
    ...MCP_WRITE_ERROR_CODES,
  ],
} satisfies ApiRouteContract;
