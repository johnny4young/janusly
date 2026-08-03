// Pure validation for the deployable Go binary manifest. The artifact builder
// owns I/O; local release checks and remote CI evidence share this exact policy.

export const RELEASE_ARTIFACT_SCHEMA_VERSION = 1;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value, label) {
  requireCondition(/^[0-9a-f]{64}$/u.test(value ?? ""), `${label} SHA-256 is required`);
  return value;
}

function exactCandidate(actual, candidate, label = "artifact") {
  requireCondition(actual?.commit === candidate.commit, `${label} commit does not match the candidate`);
  requireCondition(actual?.tree === candidate.tree, `${label} tree does not match the candidate`);
}

export function releaseArtifactTemplate(candidate) {
  return {
    schemaVersion: RELEASE_ARTIFACT_SCHEMA_VERSION,
    candidate: { ...candidate },
    target: { goos: "", goarch: "", cgoEnabled: false },
    toolchain: "",
    build: { trimpath: true, buildVcs: false, buildId: "" },
    artifact: { file: "", sha256: "", bytes: 0 },
    runtimeIdentity: {
      schemaVersion: 1,
      commit: candidate.commit,
      tree: candidate.tree,
      artifactSha256: "",
      verified: false,
    },
    sourceTreeUnchanged: false,
    pass: false,
  };
}

export function validateReleaseArtifactManifest(manifest, candidate) {
  requireCondition(manifest?.schemaVersion === RELEASE_ARTIFACT_SCHEMA_VERSION,
    "release artifact manifest schema is unsupported");
  exactCandidate(manifest.candidate, candidate);
  requireCondition(/^[a-z0-9]+$/u.test(manifest.target?.goos ?? ""), "release artifact GOOS is invalid");
  requireCondition(/^[a-z0-9]+$/u.test(manifest.target?.goarch ?? ""), "release artifact GOARCH is invalid");
  requireCondition(manifest.target?.cgoEnabled === false, "release artifact must disable CGO");
  requireCondition(typeof manifest.toolchain === "string" && /^go\d+\.\d+(?:\.\d+)?/u.test(manifest.toolchain),
    "release artifact Go toolchain is invalid");
  requireCondition(manifest.build?.trimpath === true, "release artifact must use trimpath");
  requireCondition(manifest.build?.buildVcs === false, "release artifact must disable implicit VCS metadata");
  requireCondition(manifest.build?.buildId === "", "release artifact must clear the Go build id");
  requireCondition(typeof manifest.artifact?.file === "string" && manifest.artifact.file.length > 0,
    "release artifact file is required");
  requireCondition(Number.isInteger(manifest.artifact?.bytes) && manifest.artifact.bytes > 0,
    "release artifact byte count is invalid");
  const artifactSha256 = sha256(manifest.artifact?.sha256, "release artifact");
  requireCondition(manifest.runtimeIdentity?.schemaVersion === 1,
    "release artifact runtime identity schema is unsupported");
  exactCandidate(manifest.runtimeIdentity, candidate, "runtime identity");
  requireCondition(manifest.runtimeIdentity?.verified === true, "release artifact runtime identity is not verified");
  requireCondition(sha256(manifest.runtimeIdentity?.artifactSha256, "runtime artifact") === artifactSha256,
    "runtime identity digest does not match the release artifact");
  requireCondition(manifest.sourceTreeUnchanged === true, "release artifact build changed the candidate source tree");
  requireCondition(manifest.pass === true, "release artifact manifest did not pass");
  return {
    artifactSha256,
    artifactBytes: manifest.artifact.bytes,
    goos: manifest.target.goos,
    goarch: manifest.target.goarch,
    toolchain: manifest.toolchain,
  };
}
