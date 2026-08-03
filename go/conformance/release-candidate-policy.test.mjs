import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateReleaseCandidate,
  REQUIRED_EXTERNAL_GATES,
  REQUIRED_LOCAL_CHECKS,
} from "./release-candidate-policy.mjs";

const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const ORACLE = "c".repeat(40);

function passingInput() {
  return {
    candidate: { commit: COMMIT, tree: TREE, branch: "develop", dirty: false },
    nodeOracleExpected: ORACLE,
    refs: {
      originDevelop: "d".repeat(40),
      originDevelopAncestor: true,
      originMain: "e".repeat(40),
      originMainUniquePatches: 0,
      goIntegration: "f".repeat(40),
      goIntegrationAncestor: true,
      nodeOracle: ORACLE,
      aheadOfOriginDevelop: 12,
    },
    runtime: { postgresql18Only: true },
    checkReceipt: {
      schemaVersion: 1,
      candidate: { commit: COMMIT, tree: TREE },
      checks: Object.fromEntries(REQUIRED_LOCAL_CHECKS.map(id => [id, { pass: true }])),
    },
    queueHandoffReceipt: {
      schemaVersion: 1,
      testedTree: TREE,
      nodeOracleCommit: ORACLE,
      pass: true,
    },
  };
}

test("an exact local receipt is ready for review but not production", () => {
  const verdict = evaluateReleaseCandidate(passingInput());
  assert.equal(verdict.readyForReview, true);
  assert.equal(verdict.readyForProduction, false);
  assert.deepEqual(verdict.reviewBlockers, []);
  assert.equal(verdict.productionBlockers.length, REQUIRED_EXTERNAL_GATES.length);
  assert.deepEqual(new Set(verdict.productionBlockers.map(row => row.code)), new Set(["external_gate_pending"]));
  assert.deepEqual(verdict.warnings, [{
    code: "candidate_unpublished",
    message: "Candidate contains local commits not present on fetched origin/develop",
    count: 12,
  }]);
});

test("stale and incomplete evidence fails review closed", () => {
  const input = passingInput();
  input.checkReceipt.candidate.tree = "1".repeat(40);
  input.queueHandoffReceipt.testedTree = "2".repeat(40);
  input.queueHandoffReceipt.pass = false;
  const verdict = evaluateReleaseCandidate(input);
  assert.equal(verdict.readyForReview, false);
  assert.deepEqual(new Set(verdict.reviewBlockers.map(row => row.code)), new Set([
    "local_checks_stale",
    "queue_handoff_stale",
    "queue_handoff_failed",
  ]));
});

test("dirty, divergent, non-PG18 candidates fail review closed", () => {
  const input = passingInput();
  input.candidate.dirty = true;
  input.refs.originDevelopAncestor = false;
  input.refs.originMainUniquePatches = 2;
  input.refs.goIntegrationAncestor = false;
  input.refs.nodeOracle = "0".repeat(40);
  input.runtime.postgresql18Only = false;
  const verdict = evaluateReleaseCandidate(input);
  assert.equal(verdict.readyForReview, false);
  assert.deepEqual(new Set(verdict.reviewBlockers.map(row => row.code)), new Set([
    "working_tree_dirty",
    "origin_develop_not_ancestor",
    "origin_main_unintegrated_patches",
    "go_integration_not_ancestor",
    "node_oracle_mismatch",
    "postgresql_policy_failed",
  ]));
});

test("every exact external gate is required for production readiness", () => {
  const input = passingInput();
  input.externalGateReceipt = {
    schemaVersion: 1,
    candidate: { commit: COMMIT, tree: TREE },
    gates: Object.fromEntries(REQUIRED_EXTERNAL_GATES.map(id => [id, { status: "pass" }])),
  };
  let verdict = evaluateReleaseCandidate(input);
  assert.equal(verdict.readyForReview, true);
  assert.equal(verdict.readyForProduction, true);

  input.externalGateReceipt.gates.canary.status = "fail";
  verdict = evaluateReleaseCandidate(input);
  assert.equal(verdict.readyForProduction, false);
  assert.deepEqual(verdict.productionBlockers.at(-1), {
    code: "external_gate_failed",
    message: "External gate canary has not passed",
    gate: "canary",
    status: "fail",
  });
});

test("missing required local checks are named individually", () => {
  const input = passingInput();
  delete input.checkReceipt.checks.root_contract;
  input.checkReceipt.checks.go_ci_pg18.pass = false;
  const verdict = evaluateReleaseCandidate(input);
  assert.deepEqual(verdict.reviewBlockers.filter(row => row.code.startsWith("local_check")), [
    {
      code: "local_check_missing",
      message: "Required local check root_contract is missing",
      check: "root_contract",
    },
    {
      code: "local_check_failed",
      message: "Required local check go_ci_pg18 did not pass",
      check: "go_ci_pg18",
    },
  ]);
});
