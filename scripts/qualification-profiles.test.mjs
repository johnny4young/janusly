import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_LOCAL_PROFILES,
  assertQualificationRequest,
  QUALIFICATION_PROFILES,
  resolveQualificationProfiles,
} from "./qualification-profiles.mjs";

test("all_local expands every no-cost profile exactly once", () => {
  const resolved = resolveQualificationProfiles("all_local");
  assert.deepEqual(resolved, ALL_LOCAL_PROFILES);
  assert.equal(new Set(resolved).size, resolved.length);
  assert.equal(resolved.includes("real_provider"), false);
  for (const id of resolved) assert.equal(QUALIFICATION_PROFILES[id].providerCost, false);
});

test("explicit profiles are deduplicated and unknown names fail closed", () => {
  assert.deepEqual(resolveQualificationProfiles("security,security,go_web"), ["security", "go_web"]);
  assert.throws(() => resolveQualificationProfiles(""), /at least one qualification profile/u);
  assert.throws(() => resolveQualificationProfiles("future_lab"), /unknown qualification profile/u);
});

test("destructive and provider-cost consent are independent", () => {
  assert.throws(
    () => assertQualificationRequest({
      profileIds: ["security"],
      confirmDestructive: false,
      confirmProviderCost: false,
    }),
    /--confirm-destructive/u,
  );
  assert.throws(
    () => assertQualificationRequest({
      profileIds: ["real_provider"],
      confirmDestructive: true,
      confirmProviderCost: false,
    }),
    /--confirm-provider-cost/u,
  );
  assert.deepEqual(
    assertQualificationRequest({
      profileIds: ["real_provider"],
      confirmDestructive: true,
      confirmProviderCost: true,
    }),
    ["real_provider"],
  );
});

test("go_web owns an isolated non-destructive runner", () => {
  const profile = QUALIFICATION_PROFILES.go_web;
  assert.equal(profile.destructive, false);
  assert.equal(profile.providerCost, false);
  assert.deepEqual(profile.steps, [["node", ["go/conformance/run-web-qualification.mjs"]]]);
  assert.equal("cleanup" in profile, false);
  assert.deepEqual(
    assertQualificationRequest({
      profileIds: ["go_web"],
      confirmDestructive: false,
      confirmProviderCost: false,
    }),
    ["go_web"],
  );
});

test("the catalog owns every opt-in Playwright profile", () => {
  const covered = new Set(Object.values(QUALIFICATION_PROFILES).flatMap(profile => profile.covers));
  assert.deepEqual(covered, new Set([
    "go-pilot-smoke.spec.ts",
    "local-clean-install.spec.ts",
    "local-identity-stack.spec.ts",
    "local-load-soak.spec.ts",
    "local-persistent-stack.spec.ts",
    "local-real-provider.spec.ts",
    "local-security.spec.ts",
    "local-tenant-isolation.spec.ts",
    "local-upgrade-rollback.spec.ts",
    "pagerduty-prompt-flow.spec.ts",
    "real-recovery-lab.spec.ts",
    "semantic-outcome-recovery.spec.ts",
  ]));
});
