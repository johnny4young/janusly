import assert from "node:assert/strict";
import test from "node:test";

import { ALL_LOCAL_PROFILES } from "../../scripts/qualification-profiles.mjs";
import { NODE_ORACLE_COMMIT } from "./queue-handoff-policy.mjs";
import {
  EXTERNAL_GATE_IDS,
  externalGateTemplate,
  validateExternalGateEvidence,
} from "./external-gate-policy.mjs";

const candidate = { commit: "a".repeat(40), tree: "b".repeat(40) };
const artifactSha256 = "c".repeat(64);

function releaseArtifactManifest() {
  return {
    schemaVersion: 1,
    candidate: { ...candidate },
    target: { goos: "linux", goarch: "amd64", cgoEnabled: false },
    toolchain: "go1.26.5",
    build: { trimpath: true, buildVcs: false, buildId: "" },
    artifact: { file: "janusly-go", sha256: artifactSha256, bytes: 12_345 },
    runtimeIdentity: {
      schemaVersion: 1,
      ...candidate,
      artifactSha256,
      verified: true,
    },
    sourceTreeUnchanged: true,
    pass: true,
  };
}

function runtimeProof(mode, capturedAt) {
  return {
    schemaVersion: 1,
    candidate: { ...candidate },
    capturedAt,
    runtime: {
      schemaVersion: 1,
      ...candidate,
      artifactSha256,
      verified: true,
    },
    workPlane: { header: mode, metric: mode === "active" ? 1 : 0 },
  };
}

function base(gate) {
  return {
    schemaVersion: 1,
    gate,
    candidate: { ...candidate },
    operator: "release-operator",
    capturedAt: "2026-08-03T14:00:00.000Z",
  };
}

function evidenceFor(gate) {
  const evidence = base(gate);
  if (gate === "remote_review") {
    evidence.repository = "johnny4young/janusly";
    evidence.pullRequest = {
      number: 123,
      url: "https://github.com/johnny4young/janusly/pull/123",
      base: "develop",
      headSha: candidate.commit,
      reviewDecision: "APPROVED",
      unresolvedThreads: 0,
      mergeable: true,
    };
  } else if (gate === "remote_ci") {
    evidence.run = {
      url: "https://github.com/johnny4young/janusly/actions/runs/1",
      headSha: candidate.commit,
      conclusion: "success",
      artifactManifest: releaseArtifactManifest(),
      requiredChecks: [
        { name: "build_test", conclusion: "success" },
        { name: "test_go", conclusion: "success" },
      ],
    };
  } else if (gate === "qualification") {
    const ids = [...ALL_LOCAL_PROFILES, "real_provider"];
    evidence.receipt = {
      schemaVersion: 1,
      candidate: { ...candidate },
      pass: true,
      sourceTreeUnchanged: true,
      profiles: Object.fromEntries(ids.map(id => [id, { pass: true }])),
    };
  } else if (gate === "shadow") {
    evidence.report = {
      environment: "staging-mirror",
      mode: "read_only_mirror",
      sampleCount: 1_000,
      durationMinutes: 180,
      routeFamilies: ["execution_core", "operations_recovery", "administration", "ai", "billing_budget"],
      unexpectedDiffs: 0,
      criticalDiffs: 0,
      duplicatedEffects: 0,
      runtimeProofs: [
        runtimeProof("passive", "2026-08-03T11:00:00.000Z"),
        runtimeProof("passive", "2026-08-03T14:00:00.000Z"),
      ],
      compared: { http: true, database: true, events: true, audits: true, queues: true },
    };
  } else if (gate === "cutover") {
    evidence.report = {
      runtimeProof: runtimeProof("active", "2026-08-03T14:00:00.000Z"),
      environment: "staging-cutover",
      freezeWatermark: "watermark-1",
      mutatingIngressFrozen: true,
      nodeProducersStopped: true,
      nodeToGoGate: { pass: true, testedTree: candidate.tree },
      duplicatedOwnershipSeconds: 0,
      proxyConfigSha256: "c".repeat(64),
      smokeRunId: "smoke-run-1",
    };
  } else if (gate === "canary") {
    let capturedAtMs = Date.parse("2026-08-01T12:00:00.000Z");
    evidence.report = {
      environment: "staging-canary",
      mutationOwner: "go",
      startedRuntimeProof: runtimeProof("active", new Date(capturedAtMs).toISOString()),
      autoRollbackTriggered: false,
      stages: [1, 5, 25, 50, 100].map(percent => {
        const soakMinutes = percent === 100 ? 1_440 : 60;
        capturedAtMs += soakMinutes * 60_000;
        return {
          percent,
          samples: 1_000,
          soakMinutes,
          criticalErrors: 0,
          stopThresholdsPassed: true,
          runtimeProof: runtimeProof("active", new Date(capturedAtMs).toISOString()),
        };
      }),
    };
  } else {
    evidence.report = {
      runtimeProof: runtimeProof("passive", "2026-08-03T14:00:00.000Z"),
      environment: "staging-rollback",
      nodeOracleCommit: NODE_ORACLE_COMMIT,
      goToNodeGate: { pass: true, testedTree: candidate.tree },
      backupRestorePass: true,
      nodeSmokePass: true,
      activityUiPass: true,
      dataLossCount: 0,
      inFlightLossCount: 0,
      rtoSeconds: 90,
      maxRtoSeconds: 300,
    };
  }
  return evidence;
}

test("every external gate accepts complete exact-candidate evidence", () => {
  for (const gate of EXTERNAL_GATE_IDS) {
    assert.doesNotThrow(() => validateExternalGateEvidence(gate, evidenceFor(gate), candidate), gate);
  }
});

test("every external gate rejects evidence from another candidate", () => {
  for (const gate of EXTERNAL_GATE_IDS) {
    const evidence = evidenceFor(gate);
    evidence.candidate.tree = "0".repeat(40);
    assert.throws(() => validateExternalGateEvidence(gate, evidence, candidate), /tree does not match/u, gate);
  }
});

test("runtime gates require the exact CI-built Go artifact", () => {
  const remoteCi = validateExternalGateEvidence("remote_ci", evidenceFor("remote_ci"), candidate);
  assert.equal(remoteCi.artifactSha256, artifactSha256);
  const ciWithoutArtifact = evidenceFor("remote_ci");
  delete ciWithoutArtifact.run.artifactManifest;
  assert.throws(
    () => validateExternalGateEvidence("remote_ci", ciWithoutArtifact, candidate),
    /release artifact manifest schema is unsupported/u,
  );

  for (const gate of ["shadow", "cutover", "canary", "rollback"]) {
    const evidence = evidenceFor(gate);
    const summary = validateExternalGateEvidence(gate, evidence, candidate);
    assert.deepEqual(
      {
        runtimeCommit: summary.runtimeCommit,
        runtimeTree: summary.runtimeTree,
        artifactSha256: summary.artifactSha256,
      },
      {
        runtimeCommit: candidate.commit,
        runtimeTree: candidate.tree,
        artifactSha256,
      },
    );

    const proof = gate === "shadow"
      ? evidence.report.runtimeProofs[1]
      : gate === "canary"
        ? evidence.report.stages.at(-1).runtimeProof
        : evidence.report.runtimeProof;
    proof.runtime.artifactSha256 = "not-a-sha256";
    assert.throws(
      () => validateExternalGateEvidence(gate, evidence, candidate),
      /runtime artifact SHA-256 is required/u,
      gate,
    );
    proof.runtime.artifactSha256 = artifactSha256;
    proof.runtime.commit = "0".repeat(40);
    assert.throws(
      () => validateExternalGateEvidence(gate, evidence, candidate),
      /runtime build identity commit does not match/u,
      gate,
    );
  }
});

test("every external gate template is exact-candidate and fail-closed", () => {
  for (const gate of EXTERNAL_GATE_IDS) {
    const template = externalGateTemplate(gate, candidate);
    assert.equal(template.gate, gate);
    assert.deepEqual(template.candidate, candidate);
    if (gate === "remote_ci") assert.deepEqual(template.run.artifactManifest.candidate, candidate);
    if (gate === "shadow") assert.equal(template.report.runtimeProofs.length, 2);
    if (gate === "cutover" || gate === "rollback") {
      assert.deepEqual(template.report.runtimeProof.candidate, candidate);
    }
    if (gate === "canary") assert.deepEqual(template.report.startedRuntimeProof.candidate, candidate);
    assert.throws(() => validateExternalGateEvidence(gate, template, candidate), undefined, gate);
  }
});

test("shadow rejects local, write-capable, incomplete comparisons", () => {
  const evidence = evidenceFor("shadow");
  evidence.report.environment = "local";
  assert.throws(() => validateExternalGateEvidence("shadow", evidence, candidate), /cannot use the local/u);
  evidence.report.environment = "staging";
  evidence.report.mode = "write_mirror";
  assert.throws(() => validateExternalGateEvidence("shadow", evidence, candidate), /suppress Go write effects/u);
  evidence.report.mode = "read_only_mirror";
  evidence.report.runtimeProofs[1].workPlane.header = "active";
  assert.throws(() => validateExternalGateEvidence("shadow", evidence, candidate), /header is not passive/u);
  evidence.report.runtimeProofs[1].workPlane.header = "passive";
  evidence.report.runtimeProofs[1].capturedAt = "2026-08-03T12:00:00.000Z";
  assert.throws(() => validateExternalGateEvidence("shadow", evidence, candidate), /do not span/u);
  evidence.report.runtimeProofs[1].capturedAt = "2026-08-03T14:00:00.000Z";
  evidence.report.compared.audits = false;
  assert.throws(() => validateExternalGateEvidence("shadow", evidence, candidate), /compare audits/u);
});

test("canary requires ordered stages and a full final soak", () => {
  const evidence = evidenceFor("canary");
  evidence.report.stages[2].percent = 30;
  assert.throws(() => validateExternalGateEvidence("canary", evidence, candidate), /must be 25%/u);
  evidence.report.stages[2].percent = 25;
  evidence.report.stages[2].runtimeProof.workPlane.metric = 0;
  assert.throws(() => validateExternalGateEvidence("canary", evidence, candidate), /metric is not active/u);
  evidence.report.stages[2].runtimeProof.workPlane.metric = 1;
  evidence.report.stages.at(-1).soakMinutes = 1_439;
  assert.throws(() => validateExternalGateEvidence("canary", evidence, candidate), /at least 1440/u);
  evidence.report.stages.at(-1).soakMinutes = 1_440;
  evidence.report.stages.at(-1).runtimeProof.capturedAt = evidence.report.stages.at(-2).runtimeProof.capturedAt;
  assert.throws(() => validateExternalGateEvidence("canary", evidence, candidate), /does not cover/u);
});

test("qualification, cutover, and rollback retain their safety boundaries", () => {
  const qualification = evidenceFor("qualification");
  delete qualification.receipt.profiles.real_provider;
  assert.throws(() => validateExternalGateEvidence("qualification", qualification, candidate), /count drifted/u);

  const cutover = evidenceFor("cutover");
  cutover.report.duplicatedOwnershipSeconds = 1;
  assert.throws(() => validateExternalGateEvidence("cutover", cutover, candidate), /overlapping/u);

  const rollback = evidenceFor("rollback");
  rollback.report.runtimeProof.workPlane.metric = 1;
  assert.throws(() => validateExternalGateEvidence("rollback", rollback, candidate), /metric is not passive/u);
  rollback.report.runtimeProof.workPlane.metric = 0;
  rollback.report.dataLossCount = 1;
  assert.throws(() => validateExternalGateEvidence("rollback", rollback, candidate), /lost persisted data/u);
});
