/**
 * Side-effect-free stable API contracts for the recovery domain.
 * Imported by route registries and the pure OpenAPI manifest.
 */

import { V1_READ_PATHS, V1_WRITE_PATHS } from "@janusly/shared/src/api-contract";
import { z } from "zod";

import type { ApiRouteContract } from "../api-contract-types";
import {
  IsoDateSchema,
  JsonValueSchema,
  MCP_WRITE_ERROR_CODES,
  NullableIsoDateSchema,
  PositiveLimitSchema,
  RecoveryAutonomyProfileSchema,
  RecoveryCaseSchema,
  RecoveryCaseTransitionSchema,
  RecoveryMetricsSchema,
} from "./schemas";

export const recoveryMetricsContract = {
  operationId: "getRecoveryMetrics",
  path: V1_READ_PATHS.recoveryMetrics,
  summary: "Get the tenant recovery metrics rollup",
  tags: ["Recovery"],
  request: {
    query: z.object({
      windowDays: z.coerce.number().int().min(1).max(90).optional()
        .describe("Metrics window in days (1-90, default 30)."),
    }).strict(),
  },
  response: RecoveryMetricsSchema,
  errorCodes: ["invalid_input"],
} satisfies ApiRouteContract;

export const memoryConsentStatusContract = {
  operationId: "getMemoryConsentStatus",
  path: V1_READ_PATHS.memoryConsentStatus,
  summary: "Get effective memory consent and pending purge status",
  tags: ["Memory"],
  response: z.object({
    enabled: z.boolean(),
    processEnabled: z.boolean(),
    tenantEnabled: z.boolean(),
    purge: z.discriminatedUnion("status", [
      z.object({ status: z.literal("none"), scheduledFor: z.null() }),
      z.object({ status: z.literal("scheduled"), scheduledFor: IsoDateSchema }),
      z.object({ status: z.literal("running"), scheduledFor: IsoDateSchema.nullable() }),
      z.object({ status: z.literal("unknown"), scheduledFor: z.null() }),
    ]),
  }),
  errorCodes: [],
} satisfies ApiRouteContract;

export const recoveryLedgerContract = {
  operationId: "getRecoveryLedger",
  path: V1_READ_PATHS.recoveryLedger,
  summary: "Get the tenant lifetime recovery impact ledger",
  tags: ["Recovery"],
  response: z.object({
    totalRecovered: z.number().int().nonnegative(),
    downtimeEndedMs: z.number().nonnegative(),
    sinceIso: NullableIsoDateSchema,
  }),
  errorCodes: [],
} satisfies ApiRouteContract;

export const recoveryMyWinsContract = {
  operationId: "getRecoveryMyWins",
  path: V1_READ_PATHS.recoveryMyWins,
  summary: "Get the authenticated operator's recent DLQ recoveries",
  tags: ["Recovery"],
  request: {
    query: z.object({
      days: z.coerce.number().int().optional()
        .describe("Rolling window in days; values are clamped to 1-90 (default 30)."),
    }).strict(),
  },
  response: z.object({
    recovered: z.number().int().nonnegative(),
    windowDays: z.number().int().min(1).max(90),
  }),
  errorCodes: ["invalid_input"],
} satisfies ApiRouteContract;

export const listRecoveryCasesContract = {
  operationId: "listRecoveryCases",
  path: V1_READ_PATHS.recoveryCases,
  summary:
    "List durable semantic recovery cases for the tenant",
  tags: ["Recovery"],
  request: {
    query: z
      .object({
        openOnly: z.enum(["true", "false"]).optional(),
        runId: z.string().trim().min(1).max(256).optional(),
        limit: PositiveLimitSchema.optional(),
      })
      .strict(),
  },
  response: z.object({ cases: z.array(RecoveryCaseSchema) }),
  errorCodes: ["invalid_input"],
} satisfies ApiRouteContract;

export const getRecoveryCaseContract = {
  operationId: "getRecoveryCase",
  path: V1_READ_PATHS.recoveryCase,
  summary:
    "Get one durable semantic recovery case with its append-only transition history",
  tags: ["Recovery"],
  request: {
    path: z
      .object({
        caseId: z.string().trim().min(1).max(256),
      })
      .strict(),
  },
  response: z.object({
    case: RecoveryCaseSchema,
    transitions: z.array(RecoveryCaseTransitionSchema),
    autonomy: RecoveryAutonomyProfileSchema,
  }),
  errorCodes: ["invalid_input", "recovery_case_not_found"],
} satisfies ApiRouteContract;

export const recoverSemanticCaseContract = {
  operationId: "recoverSemanticCase",
  path: V1_WRITE_PATHS.recoverSemanticCase,
  summary:
    "Resolve a semantic quarantine or acknowledge an observe-only outcome",
  tags: ["Recovery"],
  request: {
    path: z
      .object({
        caseId: z.string().trim().min(1).max(256),
      })
      .strict(),
    body: z.discriminatedUnion("decision", [
      z
        .object({
          decision: z.literal("replace"),
          output: JsonValueSchema,
          reason: z.string().trim().min(1).max(1_000),
        })
        .strict(),
      z
        .object({
          decision: z.literal("accept_loss"),
          reason: z.string().trim().min(1).max(1_000),
        })
        .strict(),
    ]),
  },
  response: z.object({
    ok: z.literal(true),
    runId: z.string(),
    sourceNodeId: z.string(),
    decision: z.enum(["replace", "accept_loss"]),
    resumed: z.boolean(),
    resolvedCaseIds: z.array(z.string()),
  }),
  errorCodes: [
    "invalid_input",
    "recovery_case_not_found",
    "recovery_case_conflict",
    "recovery_autonomy_policy_blocked",
    "recovery_semantic_output_invalid",
    ...MCP_WRITE_ERROR_CODES,
  ],
} satisfies ApiRouteContract;
