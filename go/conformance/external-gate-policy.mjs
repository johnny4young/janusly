// Pure validation for evidence captured outside the local checkout. A passing
// record is candidate-bound and materially proves one release transition gate;
// prose assertions alone are never accepted.

import { ALL_LOCAL_PROFILES } from "../../scripts/qualification-profiles.mjs";
import { NODE_ORACLE_COMMIT } from "./queue-handoff-policy.mjs";
import {
  releaseArtifactTemplate,
  validateReleaseArtifactManifest,
} from "./release-artifact-policy.mjs";
import { runtimeProofTemplate, validateRuntimeProof } from "./runtime-proof-policy.mjs";

export const EXTERNAL_GATE_POLICY_VERSION = 3;
export const EXTERNAL_GATE_IDS = Object.freeze([
  "remote_review",
  "remote_ci",
  "qualification",
  "shadow",
  "cutover",
  "canary",
  "rollback",
]);

const CANARY_PERCENTAGES = Object.freeze([1, 5, 25, 50, 100]);
const SHADOW_ROUTE_FAMILIES = Object.freeze([
  "execution_core",
  "operations_recovery",
  "administration",
  "ai",
  "billing_budget",
]);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function exactCandidate(actual, candidate, label = "evidence") {
  requireCondition(actual?.commit === candidate.commit, `${label} commit does not match the candidate`);
  requireCondition(actual?.tree === candidate.tree, `${label} tree does not match the candidate`);
}

function nonEmpty(value, label) {
  requireCondition(typeof value === "string" && value.trim().length > 0, `${label} is required`);
  return value.trim();
}

function finite(value, label, minimum = 0) {
  requireCondition(Number.isFinite(value) && value >= minimum, `${label} must be at least ${minimum}`);
  return value;
}

function exactArtifact(actual, expected, label) {
  requireCondition(actual === expected, `${label} used a different Go artifact`);
}

function runtimeSummary(proof) {
  return {
    runtimeCommit: proof.runtimeCommit,
    runtimeTree: proof.runtimeTree,
    artifactSha256: proof.artifactSha256,
  };
}

function exactSet(actual, expected, label) {
  requireCondition(Array.isArray(actual), `${label} must be an array`);
  requireCondition(actual.length === expected.length, `${label} count drifted`);
  const values = new Set(actual);
  requireCondition(values.size === expected.length, `${label} must not contain duplicates`);
  for (const value of expected) requireCondition(values.has(value), `${label} is missing ${value}`);
}

function validateRemoteReview(evidence, candidate) {
  const pullRequest = evidence.pullRequest ?? {};
  nonEmpty(evidence.repository, "repository");
  requireCondition(Number.isInteger(pullRequest.number) && pullRequest.number > 0, "pull request number is required");
  nonEmpty(pullRequest.url, "pull request URL");
  requireCondition(["develop", "main"].includes(pullRequest.base), "pull request base must be develop or main");
  requireCondition(pullRequest.headSha === candidate.commit, "pull request head must equal the candidate commit");
  requireCondition(pullRequest.reviewDecision === "APPROVED", "pull request is not approved");
  requireCondition(pullRequest.unresolvedThreads === 0, "pull request has unresolved review threads");
  requireCondition(pullRequest.mergeable === true, "pull request is not mergeable");
  return { pullRequest: pullRequest.number, url: pullRequest.url, base: pullRequest.base };
}

function validateRemoteCi(evidence, candidate) {
  const run = evidence.run ?? {};
  nonEmpty(run.url, "CI run URL");
  requireCondition(run.headSha === candidate.commit, "CI head must equal the candidate commit");
  requireCondition(run.conclusion === "success", "CI run did not succeed");
  requireCondition(Array.isArray(run.requiredChecks) && run.requiredChecks.length > 0, "CI required checks are missing");
  for (const check of run.requiredChecks) {
    nonEmpty(check?.name, "CI check name");
    requireCondition(check.conclusion === "success", `CI check ${check.name} did not succeed`);
  }
  const artifact = validateReleaseArtifactManifest(run.artifactManifest, candidate);
  return {
    url: run.url,
    requiredChecks: run.requiredChecks.length,
    ...artifact,
  };
}

function validateQualification(evidence, candidate) {
  const receipt = evidence.receipt ?? {};
  requireCondition(receipt.schemaVersion === 1, "qualification receipt schema is unsupported");
  exactCandidate(receipt.candidate, candidate);
  requireCondition(receipt.pass === true, "qualification receipt did not pass");
  requireCondition(receipt.sourceTreeUnchanged === true, "qualification changed the candidate source tree");
  const required = [...ALL_LOCAL_PROFILES, "real_provider"];
  exactSet(Object.keys(receipt.profiles ?? {}), required, "qualification profiles");
  for (const id of required) requireCondition(receipt.profiles[id]?.pass === true, `qualification profile ${id} did not pass`);
  return { profiles: required.length, realProvider: true };
}

function validateShadow(evidence, candidate) {
  const report = evidence.report ?? {};
  nonEmpty(report.environment, "shadow environment");
  requireCondition(report.environment !== "local", "production shadow evidence cannot use the local environment");
  requireCondition(report.mode === "read_only_mirror", "shadow must suppress Go write effects");
  finite(report.sampleCount, "shadow sample count", 100);
  finite(report.durationMinutes, "shadow duration", 60);
  exactSet(report.routeFamilies, SHADOW_ROUTE_FAMILIES, "shadow route families");
  requireCondition(report.unexpectedDiffs === 0, "shadow has unexpected differences");
  requireCondition(report.criticalDiffs === 0, "shadow has critical differences");
  requireCondition(report.duplicatedEffects === 0, "shadow duplicated write effects");
  requireCondition(Array.isArray(report.runtimeProofs) && report.runtimeProofs.length === 2,
    "shadow requires exactly two passive runtime proofs");
  const start = validateRuntimeProof(report.runtimeProofs[0], candidate, "passive");
  const finish = validateRuntimeProof(report.runtimeProofs[1], candidate, "passive");
  exactArtifact(finish.artifactSha256, start.artifactSha256, "shadow runtime proof");
  requireCondition(finish.capturedAtMs >= start.capturedAtMs,
    "shadow runtime proofs are not time ordered");
  const proofSpanMinutes = (finish.capturedAtMs - start.capturedAtMs) / 60_000;
  requireCondition(proofSpanMinutes >= report.durationMinutes,
    "shadow runtime proofs do not span the declared duration");
  for (const dimension of ["http", "database", "events", "audits", "queues"]) {
    requireCondition(report.compared?.[dimension] === true, `shadow did not compare ${dimension}`);
  }
  return {
    ...runtimeSummary(finish),
    environment: report.environment,
    samples: report.sampleCount,
    durationMinutes: report.durationMinutes,
    runtimeProofs: report.runtimeProofs.length,
    runtimeProofSpanMinutes: proofSpanMinutes,
  };
}

function validateCutover(evidence, candidate) {
  const report = evidence.report ?? {};
  const runtime = validateRuntimeProof(report.runtimeProof, candidate, "active");
  nonEmpty(report.environment, "cutover environment");
  nonEmpty(report.freezeWatermark, "cutover freeze watermark");
  requireCondition(report.mutatingIngressFrozen === true, "mutating ingress was not frozen");
  requireCondition(report.nodeProducersStopped === true, "Node producers were not stopped");
  requireCondition(report.nodeToGoGate?.pass === true, "node-to-go handoff gate did not pass");
  requireCondition(report.nodeToGoGate?.testedTree === candidate.tree, "node-to-go gate used a different candidate tree");
  requireCondition(report.duplicatedOwnershipSeconds === 0, "Node and Go had overlapping work-plane ownership");
  requireCondition(/^[0-9a-f]{64}$/u.test(report.proxyConfigSha256 ?? ""), "proxy config SHA-256 is required");
  nonEmpty(report.smokeRunId, "cutover smoke run id");
  return {
    ...runtimeSummary(runtime),
    environment: report.environment,
    freezeWatermark: report.freezeWatermark,
    smokeRunId: report.smokeRunId,
  };
}

function validateCanary(evidence, candidate) {
  const report = evidence.report ?? {};
  const startedRuntime = validateRuntimeProof(report.startedRuntimeProof, candidate, "active");
  nonEmpty(report.environment, "canary environment");
  requireCondition(report.mutationOwner === "go", "Go must own the global work plane before gradual read routing");
  requireCondition(report.autoRollbackTriggered === false, "canary triggered automatic rollback");
  requireCondition(Array.isArray(report.stages) && report.stages.length === CANARY_PERCENTAGES.length, "canary stage count drifted");
  let previousProof = startedRuntime;
  for (const [index, percent] of CANARY_PERCENTAGES.entries()) {
    const stage = report.stages[index] ?? {};
    requireCondition(stage.percent === percent, `canary stage ${index} must be ${percent}%`);
    finite(stage.samples, `canary ${percent}% samples`, 100);
    finite(stage.soakMinutes, `canary ${percent}% soak`, percent === 100 ? 1_440 : 30);
    requireCondition(stage.criticalErrors === 0, `canary ${percent}% has critical errors`);
    requireCondition(stage.stopThresholdsPassed === true, `canary ${percent}% failed a stop threshold`);
    const stageProof = validateRuntimeProof(stage.runtimeProof, candidate, "active");
    exactArtifact(stageProof.artifactSha256, startedRuntime.artifactSha256,
      `canary ${percent}% runtime proof`);
    requireCondition(stageProof.capturedAtMs >= previousProof.capturedAtMs + stage.soakMinutes * 60_000,
      `canary ${percent}% runtime proof does not cover its declared soak`);
    previousProof = stageProof;
  }
  return {
    ...runtimeSummary(previousProof),
    environment: report.environment,
    stages: CANARY_PERCENTAGES,
    finalSoakMinutes: report.stages.at(-1).soakMinutes,
    runtimeProofs: CANARY_PERCENTAGES.length + 1,
    runtimeProofSpanMinutes: (previousProof.capturedAtMs - startedRuntime.capturedAtMs) / 60_000,
  };
}

function validateRollback(evidence, candidate) {
  const report = evidence.report ?? {};
  const runtime = validateRuntimeProof(report.runtimeProof, candidate, "passive");
  nonEmpty(report.environment, "rollback environment");
  requireCondition(report.nodeOracleCommit === NODE_ORACLE_COMMIT, "rollback used a different Node oracle");
  requireCondition(report.goToNodeGate?.pass === true, "go-to-node handoff gate did not pass");
  requireCondition(report.goToNodeGate?.testedTree === candidate.tree, "go-to-node gate used a different candidate tree");
  requireCondition(report.backupRestorePass === true, "backup/restore proof did not pass");
  requireCondition(report.nodeSmokePass === true, "restored Node smoke did not pass");
  requireCondition(report.activityUiPass === true, "restored Activity UI did not pass");
  requireCondition(report.dataLossCount === 0, "rollback lost persisted data");
  requireCondition(report.inFlightLossCount === 0, "rollback lost in-flight work");
  finite(report.maxRtoSeconds, "maximum rollback RTO", 1);
  finite(report.rtoSeconds, "rollback RTO", 0);
  requireCondition(report.rtoSeconds <= report.maxRtoSeconds, "rollback exceeded its RTO boundary");
  return {
    ...runtimeSummary(runtime),
    environment: report.environment,
    rtoSeconds: report.rtoSeconds,
    maxRtoSeconds: report.maxRtoSeconds,
  };
}

/** Validate one raw evidence document and return its bounded manifest summary. */
export function validateExternalGateEvidence(gate, evidence, candidate) {
  requireCondition(EXTERNAL_GATE_IDS.includes(gate), `unsupported external gate: ${gate}`);
  requireCondition(evidence?.schemaVersion === 1, "external gate evidence schema is unsupported");
  requireCondition(evidence?.gate === gate, "external gate evidence type does not match the requested gate");
  exactCandidate(evidence.candidate, candidate);
  nonEmpty(evidence.operator, "gate operator");
  nonEmpty(evidence.capturedAt, "gate capture timestamp");
  requireCondition(Number.isFinite(Date.parse(evidence.capturedAt)), "gate capture timestamp is invalid");
  if (gate === "remote_review") return validateRemoteReview(evidence, candidate);
  if (gate === "remote_ci") return validateRemoteCi(evidence, candidate);
  if (gate === "qualification") return validateQualification(evidence, candidate);
  if (gate === "shadow") return validateShadow(evidence, candidate);
  if (gate === "cutover") return validateCutover(evidence, candidate);
  if (gate === "canary") return validateCanary(evidence, candidate);
  return validateRollback(evidence, candidate);
}

export function externalGateTemplate(gate, candidate) {
  requireCondition(EXTERNAL_GATE_IDS.includes(gate), `unsupported external gate: ${gate}`);
  const template = {
    schemaVersion: 1,
    gate,
    candidate,
    operator: "replace-with-operator-identity",
    capturedAt: new Date().toISOString(),
    note: "Use gate-generated facts; never replace missing evidence with prose.",
  };
  if (gate === "remote_review") {
    return {
      ...template,
      repository: "owner/repository",
      pullRequest: {
        number: 0,
        url: "",
        base: "develop",
        headSha: candidate.commit,
        reviewDecision: "",
        unresolvedThreads: null,
        mergeable: false,
      },
    };
  }
  if (gate === "remote_ci") {
    return {
      ...template,
      run: {
        url: "",
        headSha: candidate.commit,
        conclusion: "",
        artifactManifest: releaseArtifactTemplate(candidate),
        requiredChecks: [{ name: "", conclusion: "" }],
      },
    };
  }
  if (gate === "qualification") {
    const required = [...ALL_LOCAL_PROFILES, "real_provider"];
    return {
      ...template,
      receipt: {
        schemaVersion: 1,
        candidate,
        pass: false,
        sourceTreeUnchanged: false,
        profiles: Object.fromEntries(required.map(id => [id, { pass: false }])),
      },
    };
  }
  if (gate === "shadow") {
    return {
      ...template,
      report: {
        environment: "",
        mode: "read_only_mirror",
        sampleCount: 0,
        durationMinutes: 0,
        routeFamilies: [...SHADOW_ROUTE_FAMILIES],
        unexpectedDiffs: null,
        criticalDiffs: null,
        duplicatedEffects: null,
        runtimeProofs: [
          runtimeProofTemplate(candidate, "passive"),
          runtimeProofTemplate(candidate, "passive"),
        ],
        compared: { http: false, database: false, events: false, audits: false, queues: false },
      },
    };
  }
  if (gate === "cutover") {
    return {
      ...template,
      report: {
        environment: "",
        freezeWatermark: "",
        mutatingIngressFrozen: false,
        nodeProducersStopped: false,
        nodeToGoGate: { pass: false, testedTree: candidate.tree },
        runtimeProof: runtimeProofTemplate(candidate, "active"),
        duplicatedOwnershipSeconds: null,
        proxyConfigSha256: "",
        smokeRunId: "",
      },
    };
  }
  if (gate === "canary") {
    return {
      ...template,
      report: {
        environment: "",
        mutationOwner: "go",
        startedRuntimeProof: runtimeProofTemplate(candidate, "active"),
        autoRollbackTriggered: null,
        stages: CANARY_PERCENTAGES.map(percent => ({
          percent,
          samples: 0,
          soakMinutes: 0,
          criticalErrors: null,
          stopThresholdsPassed: false,
          runtimeProof: runtimeProofTemplate(candidate, "active"),
        })),
      },
    };
  }
  return {
    ...template,
    report: {
      environment: "",
      nodeOracleCommit: NODE_ORACLE_COMMIT,
      goToNodeGate: { pass: false, testedTree: candidate.tree },
      backupRestorePass: false,
      nodeSmokePass: false,
      activityUiPass: false,
      dataLossCount: null,
      inFlightLossCount: null,
      runtimeProof: runtimeProofTemplate(candidate, "passive"),
      rtoSeconds: null,
      maxRtoSeconds: null,
    },
  };
}
