// Pure release-candidate policy. Collection and command execution live in the
// run-* adapters so the fail-closed verdict stays deterministic and unit-testable.

import {
  EXTERNAL_GATE_IDS,
  EXTERNAL_GATE_POLICY_VERSION,
} from "./external-gate-policy.mjs";
import { validateReleaseArtifactManifest } from "./release-artifact-policy.mjs";

export const REQUIRED_LOCAL_CHECKS = Object.freeze([
  "root_lint",
  "root_scripts",
  "root_contract",
  "root_build",
  "root_test",
  "root_integration_pg18",
  "go_ci_pg18",
  "go_release_artifact",
  "go_revalidation_pg18",
  "go_benchmark_campaign",
  "source_tree_unchanged",
]);

export const REQUIRED_EXTERNAL_GATES = EXTERNAL_GATE_IDS;
const RUNTIME_ARTIFACT_GATES = Object.freeze(["shadow", "cutover", "canary", "rollback"]);

function issue(code, message, details = {}) {
  return { code, message, ...details };
}

function matchesCandidate(receipt, candidate) {
  return receipt?.candidate?.commit === candidate.commit &&
    receipt?.candidate?.tree === candidate.tree;
}

/** Evaluate local review readiness separately from production readiness. */
export function evaluateReleaseCandidate(input) {
  const reviewBlockers = [];
  const warnings = [];
  const candidate = input.candidate ?? {};
  const refs = input.refs ?? {};
  const runtime = input.runtime ?? {};

  if (!candidate.commit || !candidate.tree) {
    reviewBlockers.push(issue("candidate_identity_missing", "Candidate commit and tree are required"));
  }
  if (candidate.dirty) {
    reviewBlockers.push(issue("working_tree_dirty", "Release evidence must be generated from a clean worktree"));
  }
  if (!refs.originDevelop) {
    reviewBlockers.push(issue("origin_develop_missing", "The fetched origin/develop ref is required"));
  } else if (!refs.originDevelopAncestor) {
    reviewBlockers.push(issue("origin_develop_not_ancestor", "Candidate does not contain fetched origin/develop"));
  }
  if (!refs.originMain) {
    reviewBlockers.push(issue("origin_main_missing", "The fetched origin/main ref is required"));
  } else if (refs.originMainUniquePatches === null || refs.originMainUniquePatches === undefined) {
    reviewBlockers.push(issue("origin_main_patch_state_unknown", "Could not compare origin/main patches with the candidate"));
  } else if (refs.originMainUniquePatches > 0) {
    reviewBlockers.push(issue(
      "origin_main_unintegrated_patches",
      "Fetched origin/main contains patches not represented by the candidate",
      { count: refs.originMainUniquePatches },
    ));
  }
  if (!refs.goIntegration || !refs.goIntegrationAncestor) {
    reviewBlockers.push(issue("go_integration_not_ancestor", "Candidate must contain the certified go-integration head"));
  }
  if (!refs.nodeOracle || refs.nodeOracle !== input.nodeOracleExpected) {
    reviewBlockers.push(issue(
      "node_oracle_mismatch",
      "The frozen nodejs-legacy ref does not match the reviewed compatibility oracle",
      { expected: input.nodeOracleExpected ?? null, actual: refs.nodeOracle ?? null },
    ));
  }
  if (!runtime.postgresql18Only) {
    reviewBlockers.push(issue("postgresql_policy_failed", "Every Janusly-owned database service must use fixed PostgreSQL 18"));
  }

  let releaseArtifact = null;
  if (!input.releaseArtifactManifest) {
    reviewBlockers.push(issue("release_artifact_missing", "Exact-candidate Go release artifact manifest is missing"));
  } else {
    try {
      releaseArtifact = validateReleaseArtifactManifest(input.releaseArtifactManifest, candidate);
    } catch (error) {
      reviewBlockers.push(issue(
        "release_artifact_invalid",
        `Go release artifact is invalid: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }

  const checks = input.checkReceipt;
  if (!checks) {
    reviewBlockers.push(issue("local_checks_missing", "Exact-candidate local check receipt is missing"));
  } else if (checks.schemaVersion !== 1) {
    reviewBlockers.push(issue("local_checks_schema_unsupported", "Local check receipt schema is unsupported"));
  } else if (!matchesCandidate(checks, candidate)) {
    reviewBlockers.push(issue("local_checks_stale", "Local check receipt belongs to a different commit or tree"));
  } else {
    for (const id of REQUIRED_LOCAL_CHECKS) {
      const check = checks.checks?.[id];
      if (!check) {
        reviewBlockers.push(issue("local_check_missing", `Required local check ${id} is missing`, { check: id }));
      } else if (check.pass !== true) {
        reviewBlockers.push(issue("local_check_failed", `Required local check ${id} did not pass`, { check: id }));
      }
    }
    if (releaseArtifact && checks.checks?.go_release_artifact?.pass === true &&
      checks.checks.go_release_artifact.summary?.artifactSha256 !== releaseArtifact.artifactSha256) {
      reviewBlockers.push(issue(
        "release_artifact_receipt_mismatch",
        "Local check receipt and release artifact manifest describe different executable bytes",
      ));
    }
  }

  const handoff = input.queueHandoffReceipt;
  if (!handoff) {
    reviewBlockers.push(issue("queue_handoff_missing", "Exact-candidate queue handoff rehearsal receipt is missing"));
  } else {
    if (handoff.schemaVersion !== 1) {
      reviewBlockers.push(issue("queue_handoff_schema_unsupported", "Queue handoff receipt schema is unsupported"));
    }
    if (handoff.testedTree !== candidate.tree) {
      reviewBlockers.push(issue("queue_handoff_stale", "Queue handoff receipt belongs to a different candidate tree"));
    }
    if (handoff.nodeOracleCommit !== input.nodeOracleExpected) {
      reviewBlockers.push(issue("queue_handoff_oracle_mismatch", "Queue handoff receipt used a different Node oracle"));
    }
    if (handoff.pass !== true) {
      reviewBlockers.push(issue("queue_handoff_failed", "Queue handoff rehearsal did not pass every phase"));
    }
  }

  if ((refs.aheadOfOriginDevelop ?? 0) > 0) {
    warnings.push(issue(
      "candidate_unpublished",
      "Candidate contains local commits not present on fetched origin/develop",
      { count: refs.aheadOfOriginDevelop },
    ));
  }

  const externalReceipt = input.externalGateReceipt;
  const externalGateStates = {};
  const productionBlockers = [...reviewBlockers];
  const externalMatches = externalReceipt && matchesCandidate(externalReceipt, candidate);
  let externalUsable = Boolean(externalReceipt && externalMatches);
  if (externalReceipt && externalReceipt.schemaVersion !== 2) {
    productionBlockers.push(issue("external_gate_schema_unsupported", "External gate receipt schema is unsupported"));
    externalUsable = false;
  } else if (externalReceipt && externalReceipt.policyVersion !== EXTERNAL_GATE_POLICY_VERSION) {
    productionBlockers.push(issue("external_gate_policy_stale", "External gate receipt used a different policy version"));
    externalUsable = false;
  } else if (externalReceipt && !externalMatches) {
    productionBlockers.push(issue("external_gate_receipt_stale", "External gate receipt belongs to a different candidate"));
    externalUsable = false;
  }
  const ciArtifactSha256 = externalUsable
    ? externalReceipt.gates?.remote_ci?.summary?.artifactSha256
    : null;
  const ciArtifactValid = /^[0-9a-f]{64}$/u.test(ciArtifactSha256 ?? "");
  for (const gate of REQUIRED_EXTERNAL_GATES) {
    const row = externalUsable ? externalReceipt.gates?.[gate] : undefined;
    let status = row?.status;
    if (status === "pass" && (
      !/^[0-9a-f]{64}$/u.test(row.evidenceSha256 ?? "") ||
      !Number.isFinite(Date.parse(row.validatedAt ?? "")) ||
      !row.summary || typeof row.summary !== "object" || Array.isArray(row.summary)
    )) {
      status = "invalid";
    }
    if (status === "pass" && gate === "remote_ci" && !ciArtifactValid) {
      status = "invalid";
    }
    if (status === "pass" && RUNTIME_ARTIFACT_GATES.includes(gate) && (
      row.summary.runtimeCommit !== candidate.commit ||
      row.summary.runtimeTree !== candidate.tree ||
      !/^[0-9a-f]{64}$/u.test(row.summary.artifactSha256 ?? "") ||
      !ciArtifactValid ||
      row.summary.artifactSha256 !== ciArtifactSha256
    )) {
      status = "invalid";
    }
    externalGateStates[gate] = status ?? "pending";
    if (status !== "pass") {
      productionBlockers.push(issue(
        status === "fail"
          ? "external_gate_failed"
          : status === "invalid"
            ? "external_gate_invalid"
            : "external_gate_pending",
        `External gate ${gate} has not passed`,
        { gate, status: status ?? "pending" },
      ));
    }
  }

  return {
    readyForReview: reviewBlockers.length === 0,
    readyForProduction: productionBlockers.length === 0,
    reviewBlockers,
    productionBlockers,
    warnings,
    externalGateStates,
    releaseArtifact,
  };
}
