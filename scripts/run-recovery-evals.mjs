import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RecoveryContractSchema,
  WorkflowSchema,
  buildRecoveryNorthStarSample,
  classifyTechnicalRecoveryRepair,
  evaluateTechnicalRecoveryAutonomy,
} from "../packages/shared/src/index.ts";
import { normalizeErrorSignature } from "../packages/shared/src/error-signature.ts";

import {
  applyConfigPatchToWorkflow,
  applyStructuralPatchToWorkflow,
} from "../apps/api/src/patch-workflow-merge";
import { recoverySuggestionSafety } from "../apps/api/src/recovery-suggestion-safety";
import { rankRecoverySuggestions } from "../apps/api/src/recovery-suggestion-ranking";
import { qualifyRecoveryCandidate } from "../packages/engine/src/recovery-qualification";
import {
  gateRecoveryEval,
  recoveryDatasetHash,
  summarizeRecoveryEval,
} from "./recovery-eval-gate.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const requireFromApi = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const { z } = requireFromApi("zod");
const datasetPath = `${rootDir}/evals/recovery-intelligence.json`;
const baselinePath = `${rootDir}/evals/recovery-baseline.json`;

const ErrorExpectationSchema = z.object({
  signature: z.string(),
  category: z.string(),
  suggestedOwner: z.string(),
  forbiddenSubstrings: z.array(z.string()).optional(),
}).strict();

const SafetyExpectationSchema = z.object({
  writeSide: z.boolean(),
  approvalRequired: z.boolean(),
  approvalPresent: z.boolean(),
}).strict();

const CommonCaseSchema = z.object({
  id: z.string().trim().min(1),
  capability: z.string().trim().min(1),
  critical: z.boolean().default(false),
});

const RecoveryEvalCaseSchema = z.discriminatedUnion("kind", [
  CommonCaseSchema.extend({
    kind: z.literal("error_signature"),
    input: z.object({
      error: z.unknown(),
      context: z.object({
        nodeType: z.string().optional(),
        nodeId: z.string().optional(),
        toolName: z.string().optional(),
      }).strict().optional(),
    }).strict(),
    expect: ErrorExpectationSchema,
  }).strict(),
  CommonCaseSchema.extend({
    kind: z.literal("repair"),
    input: z.object({
      original: z.unknown(),
      failingNodeId: z.string().trim().min(1),
      operation: z.discriminatedUnion("type", [
        z.object({
          type: z.literal("config_patch"),
          patch: z.record(z.string(), z.unknown()),
        }).strict(),
        z.object({
          type: z.literal("structural_patch"),
          patch: z.object({
            action: z.literal("insert_approval_upstream"),
            approvalNodeId: z.string(),
            approvalMessage: z.string(),
            insertBeforeNodeId: z.string(),
          }).strict(),
        }).strict(),
        z.object({
          type: z.literal("candidate"),
          workflow: z.unknown(),
        }).strict(),
      ]),
    }).strict(),
    expect: z.object({
      repairClass: z.enum([
        "retry",
        "config_patch",
        "structural_patch",
        "rollback",
        "credential_rotation",
        "upstream_wait",
      ]).nullable(),
      validWorkflow: z.boolean(),
      safety: SafetyExpectationSchema.optional(),
    }).strict(),
  }).strict(),
  CommonCaseSchema.extend({
    kind: z.literal("safety"),
    input: z.object({
      workflow: z.unknown(),
      nodeId: z.string().trim().min(1),
    }).strict(),
    expect: SafetyExpectationSchema,
  }).strict(),
  CommonCaseSchema.extend({
    kind: z.literal("qualification"),
    input: z.object({
      baseline: z.unknown(),
      candidate: z.unknown(),
    }).strict(),
    expect: z.object({
      mode: z.enum(["not_required", "bootstrap", "compare"]),
      status: z.enum(["not_required", "passed", "failed"]),
      regressionCount: z.number().int().nonnegative(),
      coverageFailureCount: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  CommonCaseSchema.extend({
    kind: z.literal("autonomy"),
    input: z.object({
      contract: z.unknown().nullable(),
      failure: z.enum(["terminal_node_failure", "stalled_node"]),
      repairClass: z.enum([
        "retry",
        "config_patch",
        "structural_patch",
        "rollback",
        "credential_rotation",
        "upstream_wait",
      ]).nullable(),
      validationEvidenceLevel: z.enum([
        "static",
        "sandbox",
        "provider_simulated",
        "live_canary",
      ]),
      priorVerifiedRecoveries: z.number().int().nonnegative(),
      affectedExecutions: z.number().int().nonnegative(),
      rollbackReady: z.boolean(),
    }).strict(),
    expect: z.object({
      eligible: z.boolean(),
      blockedFactors: z.array(z.string()),
    }).strict(),
  }).strict(),
  CommonCaseSchema.extend({
    kind: z.literal("north_star"),
    input: z.object({
      caseId: z.string(),
      source: z.enum(["technical_failure", "semantic_violation"]),
      verificationKind: z.enum([
        "generation_bound_terminal_success",
        "contract_outcome_verified",
      ]),
      runKind: z.enum(["production", "validation"]),
      outcome: z.enum([
        "detected",
        "contained",
        "diagnosed",
        "candidates_ready",
        "validating",
        "awaiting_approval",
        "publishing",
        "monitoring",
        "verified_recovered",
        "recurred",
        "accepted_loss",
        "abandoned",
      ]),
      detectedAt: z.string(),
      verifiedRecoveredAt: z.string(),
    }).strict(),
    expect: z.discriminatedUnion("included", [
      z.object({
        included: z.literal(true),
        durationMs: z.number().int().nonnegative(),
      }).strict(),
      z.object({
        included: z.literal(false),
        reason: z.enum([
          "non_production",
          "outcome_not_verified",
          "invalid_timestamp",
          "negative_duration",
        ]),
      }).strict(),
    ]),
  }).strict(),
  CommonCaseSchema.extend({
    kind: z.literal("ranking"),
    input: z.object({
      suggestions: z.array(z.object({
        id: z.string(),
        confidence: z.number().nullable().optional(),
      }).strict()),
    }).strict(),
    expect: z.object({
      ids: z.array(z.string()),
    }).strict(),
  }).strict(),
]);

const RecoveryEvalDatasetSchema = z.object({
  schemaVersion: z.literal("1"),
  datasetVersion: z.string().trim().min(1),
  description: z.string().trim().min(1),
  cases: z.array(RecoveryEvalCaseSchema).min(1),
}).strict().superRefine((dataset, context) => {
  const ids = new Set();
  for (const [index, item] of dataset.cases.entries()) {
    if (ids.has(item.id)) {
      context.addIssue({
        code: "custom",
        path: ["cases", index, "id"],
        message: `Duplicate recovery eval id "${item.id}"`,
      });
    }
    ids.add(item.id);
  }
});

const RecoveryEvalBaselineSchema = z.object({
  schemaVersion: z.literal("1"),
  datasetVersion: z.string().trim().min(1),
  datasetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  caseCount: z.number().int().positive(),
  capabilities: z.array(z.string().trim().min(1)).min(1),
  minimums: z.object({
    overallPassRate: z.number().min(0).max(1),
    capabilityPassRate: z.number().min(0).max(1),
    criticalPassRate: z.number().min(0).max(1),
  }).strict(),
  maximums: z.object({
    unsafeAcceptanceCount: z.number().int().nonnegative(),
    secretLeakCount: z.number().int().nonnegative(),
  }).strict(),
  execution: z.object({
    provider: z.string().nullable(),
    model: z.string().nullable(),
    parameters: z.string(),
    promptSchema: z.string().nullable(),
    environment: z.string(),
    confidenceInterval: z.string(),
    costUsd: z.number().nonnegative(),
  }).strict(),
  limitations: z.array(z.string()),
  updatedAt: z.string().datetime(),
}).strict();

function parseArguments(argv) {
  let reportPath = null;
  let updateBaseline = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--update-baseline") {
      updateBaseline = true;
    } else if (value === "--report") {
      reportPath = argv[index + 1] ?? null;
      index += 1;
    } else if (value?.startsWith("--report=")) {
      reportPath = value.slice("--report=".length);
    }
  }
  return { reportPath, updateBaseline };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function issue(issues, label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    issues.push(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function countForbiddenSubstrings(value, forbiddenSubstrings = []) {
  const serialized = JSON.stringify(value);
  return forbiddenSubstrings.filter((substring) =>
    serialized.includes(substring)
  ).length;
}

function resultBase(evalCase) {
  return {
    id: evalCase.id,
    capability: evalCase.capability,
    critical: evalCase.critical,
    passed: false,
    unsafeAccepted: false,
    secretLeakCount: 0,
    issues: [],
  };
}

function evaluateErrorSignature(evalCase) {
  const result = resultBase(evalCase);
  const actual = normalizeErrorSignature(
    evalCase.input.error,
    evalCase.input.context,
  );
  issue(result.issues, "signature", actual.signature, evalCase.expect.signature);
  issue(result.issues, "category", actual.category, evalCase.expect.category);
  issue(
    result.issues,
    "suggestedOwner",
    actual.suggestedOwner,
    evalCase.expect.suggestedOwner,
  );
  result.secretLeakCount = countForbiddenSubstrings(
    actual,
    evalCase.expect.forbiddenSubstrings,
  );
  if (result.secretLeakCount > 0) {
    result.issues.push(
      `${result.secretLeakCount} forbidden secret substring(s) reached the normalized output`,
    );
  }
  result.passed = result.issues.length === 0;
  return result;
}

function evaluateRepair(evalCase) {
  const result = resultBase(evalCase);
  const original = WorkflowSchema.parse(evalCase.input.original);
  let candidate;
  if (evalCase.input.operation.type === "config_patch") {
    candidate = applyConfigPatchToWorkflow(
      original,
      evalCase.input.failingNodeId,
      evalCase.input.operation.patch,
    );
  } else if (evalCase.input.operation.type === "structural_patch") {
    candidate = applyStructuralPatchToWorkflow(
      original,
      evalCase.input.operation.patch,
      evalCase.input.failingNodeId,
    );
  } else {
    candidate = evalCase.input.operation.workflow;
  }

  const validWorkflow = WorkflowSchema.safeParse(candidate).success;
  const repairClass = classifyTechnicalRecoveryRepair({
    original,
    candidate,
    failingNodeId: evalCase.input.failingNodeId,
  });
  issue(
    result.issues,
    "repairClass",
    repairClass,
    evalCase.expect.repairClass,
  );
  issue(
    result.issues,
    "validWorkflow",
    validWorkflow,
    evalCase.expect.validWorkflow,
  );

  if (evalCase.expect.safety) {
    const safety = recoverySuggestionSafety(
      candidate,
      evalCase.input.failingNodeId,
    );
    issue(result.issues, "safety", safety, evalCase.expect.safety);
  }
  result.unsafeAccepted =
    evalCase.expect.repairClass === null && repairClass !== null;
  result.passed = result.issues.length === 0;
  return result;
}

function evaluateSafety(evalCase) {
  const result = resultBase(evalCase);
  const actual = recoverySuggestionSafety(
    evalCase.input.workflow,
    evalCase.input.nodeId,
  );
  issue(result.issues, "safety", actual, evalCase.expect);
  result.unsafeAccepted =
    evalCase.expect.approvalPresent === false &&
    actual.approvalPresent === true;
  result.passed = result.issues.length === 0;
  return result;
}

function evaluateQualification(evalCase) {
  const result = resultBase(evalCase);
  const actual = qualifyRecoveryCandidate({
    baseline: WorkflowSchema.parse(evalCase.input.baseline),
    candidate: WorkflowSchema.parse(evalCase.input.candidate),
  });
  issue(result.issues, "mode", actual.mode, evalCase.expect.mode);
  issue(result.issues, "status", actual.status, evalCase.expect.status);
  issue(
    result.issues,
    "regressionCount",
    actual.regressionCount,
    evalCase.expect.regressionCount,
  );
  issue(
    result.issues,
    "coverageFailureCount",
    actual.coverageFailureCount,
    evalCase.expect.coverageFailureCount,
  );
  result.unsafeAccepted =
    evalCase.expect.status === "failed" && actual.status !== "failed";
  result.passed = result.issues.length === 0;
  return result;
}

function evaluateAutonomy(evalCase) {
  const result = resultBase(evalCase);
  const contract = evalCase.input.contract === null
    ? null
    : RecoveryContractSchema.parse(evalCase.input.contract);
  const actual = evaluateTechnicalRecoveryAutonomy({
    ...evalCase.input,
    contract,
  });
  const blockedFactors = actual.factors
    .filter((factor) => !factor.passed)
    .map((factor) => factor.id);
  issue(result.issues, "eligible", actual.eligible, evalCase.expect.eligible);
  issue(
    result.issues,
    "blockedFactors",
    blockedFactors,
    evalCase.expect.blockedFactors,
  );
  result.unsafeAccepted =
    evalCase.expect.eligible === false && actual.eligible === true;
  result.passed = result.issues.length === 0;
  return result;
}

function evaluateNorthStar(evalCase) {
  const result = resultBase(evalCase);
  const actual = buildRecoveryNorthStarSample(evalCase.input);
  issue(
    result.issues,
    "included",
    actual.included,
    evalCase.expect.included,
  );
  if (actual.included && evalCase.expect.included) {
    issue(
      result.issues,
      "durationMs",
      actual.sample.durationMs,
      evalCase.expect.durationMs,
    );
  } else if (!actual.included && !evalCase.expect.included) {
    issue(result.issues, "reason", actual.reason, evalCase.expect.reason);
  }
  result.unsafeAccepted =
    evalCase.expect.included === false && actual.included === true;
  result.passed = result.issues.length === 0;
  return result;
}

function evaluateRanking(evalCase) {
  const result = resultBase(evalCase);
  const actual = rankRecoverySuggestions(evalCase.input.suggestions)
    .map((suggestion) => suggestion.id);
  issue(result.issues, "ids", actual, evalCase.expect.ids);
  result.passed = result.issues.length === 0;
  return result;
}

function evaluateCase(evalCase) {
  try {
    switch (evalCase.kind) {
      case "error_signature":
        return evaluateErrorSignature(evalCase);
      case "repair":
        return evaluateRepair(evalCase);
      case "safety":
        return evaluateSafety(evalCase);
      case "qualification":
        return evaluateQualification(evalCase);
      case "autonomy":
        return evaluateAutonomy(evalCase);
      case "north_star":
        return evaluateNorthStar(evalCase);
      case "ranking":
        return evaluateRanking(evalCase);
      default:
        throw new Error(`Unsupported eval kind "${evalCase.kind}"`);
    }
  } catch (error) {
    return {
      ...resultBase(evalCase),
      issues: [
        error instanceof Error ? error.message : String(error),
      ],
    };
  }
}

function gitSource() {
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
    }).trim();
    const dirty = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      { cwd: rootDir, encoding: "utf8" },
    ).trim().length > 0;
    return { revision, dirty };
  } catch {
    return { revision: "unknown", dirty: true };
  }
}

function baselineFromRun(dataset, summary, previous = {}) {
  return {
    schemaVersion: "1",
    datasetVersion: dataset.datasetVersion,
    datasetSha256: recoveryDatasetHash(dataset),
    caseCount: summary.caseCount,
    capabilities: Object.keys(summary.capabilities).sort(),
    minimums: {
      overallPassRate: 1,
      capabilityPassRate: 1,
      criticalPassRate: 1,
    },
    maximums: {
      unsafeAcceptanceCount: 0,
      secretLeakCount: 0,
    },
    execution: {
      provider: null,
      model: null,
      parameters: "deterministic production seams",
      promptSchema: null,
      environment: "offline",
      confidenceInterval: "not_applicable_deterministic",
      costUsd: 0,
    },
    limitations: previous.limitations ?? [
      "This baseline proves deterministic recovery controls, not model diagnosis quality.",
      "Live-provider precision, repair usefulness, and business outcomes require a separately approved provider run or design-partner evidence.",
    ],
    updatedAt: new Date().toISOString(),
  };
}

function writeReport(path, report) {
  const absolute = path.startsWith("/") ? path : `${rootDir}/${path}`;
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`);
  return absolute;
}

const args = parseArguments(process.argv.slice(2));
const dataset = RecoveryEvalDatasetSchema.parse(
  readJson(datasetPath, "recovery eval dataset"),
);
const results = dataset.cases.map(evaluateCase);
const summary = summarizeRecoveryEval(results);

for (const result of results) {
  const marker = result.passed ? "✓" : "✗";
  const detail = result.passed
    ? "passed"
    : result.issues.join("; ");
  console.log(`${marker} ${result.id} [${result.capability}]: ${detail}`);
}

let baseline = null;
if (existsSync(baselinePath)) {
  baseline = RecoveryEvalBaselineSchema.parse(
    readJson(baselinePath, "recovery eval baseline"),
  );
} else if (!args.updateBaseline) {
  throw new Error(
    "recovery eval baseline is missing; run pnpm evals:recovery:baseline",
  );
}

if (args.updateBaseline) {
  if (
    summary.failedCount > 0 ||
    summary.unsafeAcceptanceCount > 0 ||
    summary.secretLeakCount > 0
  ) {
    console.error(
      "\n[recovery-evals] refusing to update a baseline from a failing or unsafe run",
    );
    process.exitCode = 1;
  } else {
    baseline = baselineFromRun(dataset, summary, baseline ?? {});
    writeFileSync(
      baselinePath,
      `${JSON.stringify(baseline, null, 2)}\n`,
    );
    console.log(`\n[recovery-evals] baseline updated: ${baseline.datasetSha256}`);
  }
}

const decision = baseline
  ? gateRecoveryEval({ dataset, summary, baseline })
  : {
      failed: true,
      reasons: ["recovery baseline is missing; run pnpm evals:recovery:baseline"],
      datasetSha256: recoveryDatasetHash(dataset),
    };
const report = {
  schemaVersion: "1",
  suite: "recovery-intelligence",
  ranAt: new Date().toISOString(),
  source: gitSource(),
  dataset: {
    version: dataset.datasetVersion,
    sha256: decision.datasetSha256,
    caseCount: summary.caseCount,
  },
  execution: {
    mode: "offline_deterministic",
    provider: null,
    model: null,
    costUsd: 0,
  },
  summary,
  gate: {
    passed: !decision.failed,
    reasons: decision.reasons,
  },
  limitations: baseline?.limitations ?? [],
  results,
};

if (args.reportPath) {
  console.log(`report: ${writeReport(args.reportPath, report)}`);
}

console.log(
  `\n[recovery-evals] ${summary.passedCount}/${summary.caseCount} passed · ` +
  `${summary.criticalPassedCount}/${summary.criticalCaseCount} critical · ` +
  `${summary.unsafeAcceptanceCount} unsafe acceptances · ` +
  `${summary.secretLeakCount} secret leaks`,
);
if (decision.failed) {
  console.error(`[recovery-evals] FAIL: ${decision.reasons.join("; ")}`);
}
process.exitCode = decision.failed ? 1 : 0;
