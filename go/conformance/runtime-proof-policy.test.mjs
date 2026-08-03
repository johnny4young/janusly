import assert from "node:assert/strict";
import test from "node:test";

import { runtimeProofTemplate, validateRuntimeProof } from "./runtime-proof-policy.mjs";

const candidate = { commit: "a".repeat(40), tree: "b".repeat(40) };
const digest = "c".repeat(64);

function proof(mode = "passive") {
  return {
    schemaVersion: 1,
    candidate: { ...candidate },
    capturedAt: "2026-08-03T15:00:00.000Z",
    runtime: {
      schemaVersion: 1,
      ...candidate,
      artifactSha256: digest,
      verified: true,
    },
    workPlane: { header: mode, metric: mode === "active" ? 1 : 0 },
  };
}

test("machine runtime proof binds source, executable, header, and metric", () => {
  assert.deepEqual(validateRuntimeProof(proof("active"), candidate, "active"), {
    capturedAt: "2026-08-03T15:00:00.000Z",
    capturedAtMs: Date.parse("2026-08-03T15:00:00.000Z"),
    runtimeCommit: candidate.commit,
    runtimeTree: candidate.tree,
    artifactSha256: digest,
    workPlaneHeader: "active",
    workPlaneMetric: 1,
  });
});

test("runtime proof rejects stale source and unverified bytes", () => {
  const stale = proof();
  stale.runtime.tree = "0".repeat(40);
  assert.throws(() => validateRuntimeProof(stale, candidate, "passive"), /build identity tree/u);

  const unverified = proof();
  unverified.runtime.verified = false;
  assert.throws(() => validateRuntimeProof(unverified, candidate, "passive"), /not verified/u);
});

test("runtime proof requires header and metric to agree with the gate", () => {
  const wrongHeader = proof("active");
  wrongHeader.workPlane.header = "passive";
  assert.throws(() => validateRuntimeProof(wrongHeader, candidate, "active"), /header is not active/u);

  const wrongMetric = proof("active");
  wrongMetric.workPlane.metric = 0;
  assert.throws(() => validateRuntimeProof(wrongMetric, candidate, "active"), /metric is not active/u);
});

test("runtime proof template is exact-candidate and fail-closed", () => {
  const template = runtimeProofTemplate(candidate, "passive");
  assert.deepEqual(template.candidate, candidate);
  assert.deepEqual(
    { commit: template.runtime.commit, tree: template.runtime.tree },
    candidate,
  );
  assert.throws(() => validateRuntimeProof(template, candidate, "passive"));
  assert.throws(() => runtimeProofTemplate(candidate, "standby"), /template mode is invalid/u);
});
