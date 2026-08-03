// Pure validation for one machine-collected runtime snapshot. The collector
// reads the internal build identity, public ownership header, and internal
// ownership metric; rollout gates compose snapshots over time.

export const RUNTIME_PROOF_SCHEMA_VERSION = 1;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function exactCandidate(actual, candidate, label) {
  requireCondition(actual?.commit === candidate.commit, `${label} commit does not match the candidate`);
  requireCondition(actual?.tree === candidate.tree, `${label} tree does not match the candidate`);
}

function sha256(value, label) {
  requireCondition(/^[0-9a-f]{64}$/u.test(value ?? ""), `${label} SHA-256 is required`);
  return value;
}

export function runtimeProofTemplate(candidate, mode) {
  requireCondition(["active", "passive"].includes(mode), "runtime proof template mode is invalid");
  const metric = mode === "active" ? 1 : 0;
  return {
    schemaVersion: RUNTIME_PROOF_SCHEMA_VERSION,
    candidate: { ...candidate },
    capturedAt: "",
    runtime: {
      schemaVersion: 1,
      commit: candidate.commit,
      tree: candidate.tree,
      artifactSha256: "",
      verified: false,
    },
    workPlane: { header: "", metric },
  };
}

export function validateRuntimeProof(proof, candidate, expectedMode) {
  requireCondition(proof?.schemaVersion === RUNTIME_PROOF_SCHEMA_VERSION,
    "runtime proof schema is unsupported");
  exactCandidate(proof.candidate, candidate, "runtime proof");
  const capturedAtMs = Date.parse(proof.capturedAt ?? "");
  requireCondition(Number.isFinite(capturedAtMs), "runtime proof capture timestamp is invalid");
  requireCondition(proof.runtime?.schemaVersion === 1, "runtime build identity schema is unsupported");
  exactCandidate(proof.runtime, candidate, "runtime build identity");
  requireCondition(proof.runtime?.verified === true, "runtime build identity is not verified");
  const artifactSha256 = sha256(proof.runtime?.artifactSha256, "runtime artifact");
  requireCondition(["active", "passive"].includes(expectedMode), "runtime proof expected mode is invalid");
  const expectedMetric = expectedMode === "active" ? 1 : 0;
  requireCondition(proof.workPlane?.header === expectedMode,
    `runtime work-plane header is not ${expectedMode}`);
  requireCondition(proof.workPlane?.metric === expectedMetric,
    `runtime work-plane metric is not ${expectedMode}`);
  return {
    capturedAt: proof.capturedAt,
    capturedAtMs,
    runtimeCommit: proof.runtime.commit,
    runtimeTree: proof.runtime.tree,
    artifactSha256,
    workPlaneHeader: proof.workPlane.header,
    workPlaneMetric: proof.workPlane.metric,
  };
}
