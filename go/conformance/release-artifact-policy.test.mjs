import assert from "node:assert/strict";
import test from "node:test";

import {
  releaseArtifactTemplate,
  validateReleaseArtifactManifest,
} from "./release-artifact-policy.mjs";

const candidate = { commit: "a".repeat(40), tree: "b".repeat(40) };
const digest = "c".repeat(64);

function passingManifest() {
  return {
    schemaVersion: 1,
    candidate: { ...candidate },
    target: { goos: "linux", goarch: "amd64", cgoEnabled: false },
    toolchain: "go1.26.5",
    build: { trimpath: true, buildVcs: false, buildId: "" },
    artifact: { file: "janusly-go", sha256: digest, bytes: 12_345 },
    runtimeIdentity: {
      schemaVersion: 1,
      commit: candidate.commit,
      tree: candidate.tree,
      artifactSha256: digest,
      verified: true,
    },
    sourceTreeUnchanged: true,
    pass: true,
  };
}

test("exact native artifact manifest passes with one runtime digest", () => {
  assert.deepEqual(validateReleaseArtifactManifest(passingManifest(), candidate), {
    artifactSha256: digest,
    artifactBytes: 12_345,
    goos: "linux",
    goarch: "amd64",
    toolchain: "go1.26.5",
  });
});

test("artifact manifest rejects source, runtime, and digest drift", () => {
  const staleSource = passingManifest();
  staleSource.candidate.tree = "0".repeat(40);
  assert.throws(() => validateReleaseArtifactManifest(staleSource, candidate), /artifact tree does not match/u);

  const staleRuntime = passingManifest();
  staleRuntime.runtimeIdentity.commit = "0".repeat(40);
  assert.throws(() => validateReleaseArtifactManifest(staleRuntime, candidate), /runtime identity commit/u);

  const digestDrift = passingManifest();
  digestDrift.runtimeIdentity.artifactSha256 = "d".repeat(64);
  assert.throws(() => validateReleaseArtifactManifest(digestDrift, candidate), /digest does not match/u);
});

test("artifact manifest rejects unsafe or incomplete build posture", () => {
  const cgo = passingManifest();
  cgo.target.cgoEnabled = true;
  assert.throws(() => validateReleaseArtifactManifest(cgo, candidate), /disable CGO/u);

  const implicitVcs = passingManifest();
  implicitVcs.build.buildVcs = true;
  assert.throws(() => validateReleaseArtifactManifest(implicitVcs, candidate), /disable implicit VCS/u);

  const changed = passingManifest();
  changed.sourceTreeUnchanged = false;
  assert.throws(() => validateReleaseArtifactManifest(changed, candidate), /changed the candidate/u);
});

test("artifact template is exact-candidate and fail-closed", () => {
  const template = releaseArtifactTemplate(candidate);
  assert.deepEqual(template.candidate, candidate);
  assert.equal(template.runtimeIdentity.commit, candidate.commit);
  assert.throws(() => validateReleaseArtifactManifest(template, candidate));
});
