import assert from "node:assert/strict";
import test from "node:test";
import { validateTenantIsolationSnapshot } from "./tenant-isolation-policy.mjs";

const expected = {
  ownerEmail: "owner@example.test",
  memberEmail: "member@example.test",
  alpha: {
    name: "Alpha",
    workflowId: "workflow-alpha",
    credentialName: "credential-alpha",
    inviteEmail: "member@example.test",
    timeoutMs: 4_100,
  },
  beta: {
    name: "Beta",
    workflowId: "workflow-beta",
    credentialName: "credential-beta",
    inviteEmail: "beta@example.test",
    timeoutMs: 5_200,
  },
};

function validSnapshot() {
  return {
    organizations: [
      { id: "org-alpha", name: "Alpha" },
      { id: "org-beta", name: "Beta" },
    ],
    workflows: [
      { id: "workflow-alpha", orgId: "org-alpha" },
      { id: "workflow-beta", orgId: "org-beta" },
    ],
    runs: [
      { workflowId: "workflow-alpha", orgId: "org-alpha" },
      { workflowId: "workflow-beta", orgId: "org-beta" },
    ],
    credentials: [
      { name: "credential-alpha", orgId: "org-alpha" },
      { name: "credential-beta", orgId: "org-beta" },
    ],
    invitations: [
      { email: "member@example.test", orgId: "org-alpha" },
      { email: "beta@example.test", orgId: "org-beta" },
    ],
    configs: [
      { orgId: "org-alpha", value: 4_100 },
      { orgId: "org-beta", value: 5_200 },
    ],
    identities: [
      { email: "owner@example.test" },
      { email: "member@example.test" },
    ],
    memberships: [
      { email: "owner@example.test", orgId: "org-alpha" },
      { email: "owner@example.test", orgId: "org-beta" },
      { email: "member@example.test", orgId: "org-alpha" },
    ],
    audits: [
      { orgId: "org-alpha", count: 4 },
      { orgId: "org-beta", count: 3 },
    ],
  };
}

test("accepts exact data and membership isolation", () => {
  assert.deepEqual(
    validateTenantIsolationSnapshot(validSnapshot(), expected),
    {
      organizationIds: {
        alpha: "org-alpha",
        beta: "org-beta",
      },
      identities: 2,
      memberships: 3,
      workflows: 2,
      runs: 2,
      credentials: 2,
      invitations: 2,
      configs: 2,
    },
  );
});

test("rejects a resource bound to the wrong organization", () => {
  const snapshot = validSnapshot();
  snapshot.credentials[1].orgId = "org-alpha";

  assert.throws(
    () => validateTenantIsolationSnapshot(snapshot, expected),
    /beta credential crossed an organization boundary/u,
  );
});

test("rejects an extra member grant in the other organization", () => {
  const snapshot = validSnapshot();
  snapshot.memberships.push({
    email: "member@example.test",
    orgId: "org-beta",
  });

  assert.throws(
    () => validateTenantIsolationSnapshot(snapshot, expected),
    /membership grants crossed/u,
  );
});
