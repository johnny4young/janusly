import assert from "node:assert/strict";

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function exactBinding(rows, field, value, orgId, label) {
  const matches = rows.filter((row) => row[field] === value);
  assert.equal(matches.length, 1, `${label} must exist exactly once`);
  assert.equal(matches[0].orgId, orgId, `${label} crossed an organization boundary`);
}

export function validateTenantIsolationSnapshot(snapshot, expected) {
  assert.equal(snapshot.organizations.length, 2, "expected exactly two qualified organizations");
  const orgByName = new Map(
    snapshot.organizations.map((organization) => [
      organization.name,
      organization.id,
    ]),
  );
  const alphaOrgId = orgByName.get(expected.alpha.name);
  const betaOrgId = orgByName.get(expected.beta.name);
  assert.ok(alphaOrgId, "alpha organization is missing");
  assert.ok(betaOrgId, "beta organization is missing");
  assert.notEqual(alphaOrgId, betaOrgId, "qualified organizations share an id");

  exactBinding(
    snapshot.workflows,
    "id",
    expected.alpha.workflowId,
    alphaOrgId,
    "alpha workflow",
  );
  exactBinding(
    snapshot.workflows,
    "id",
    expected.beta.workflowId,
    betaOrgId,
    "beta workflow",
  );
  exactBinding(
    snapshot.credentials,
    "name",
    expected.alpha.credentialName,
    alphaOrgId,
    "alpha credential",
  );
  exactBinding(
    snapshot.credentials,
    "name",
    expected.beta.credentialName,
    betaOrgId,
    "beta credential",
  );
  exactBinding(
    snapshot.invitations,
    "email",
    expected.alpha.inviteEmail,
    alphaOrgId,
    "alpha invitation",
  );
  exactBinding(
    snapshot.invitations,
    "email",
    expected.beta.inviteEmail,
    betaOrgId,
    "beta invitation",
  );
  exactBinding(
    snapshot.runs,
    "workflowId",
    expected.alpha.workflowId,
    alphaOrgId,
    "alpha run",
  );
  exactBinding(
    snapshot.runs,
    "workflowId",
    expected.beta.workflowId,
    betaOrgId,
    "beta run",
  );

  for (const [label, tenant, orgId] of [
    ["alpha", expected.alpha, alphaOrgId],
    ["beta", expected.beta, betaOrgId],
  ]) {
    const config = snapshot.configs.filter((row) => row.orgId === orgId);
    assert.equal(config.length, 1, `${label} config must exist exactly once`);
    assert.equal(
      config[0].value,
      tenant.timeoutMs,
      `${label} config has the wrong value`,
    );
  }

  assert.deepEqual(
    sorted(snapshot.identities.map(({ email }) => email)),
    sorted([expected.ownerEmail, expected.memberEmail]),
    "qualified Auth identities drifted",
  );
  assert.deepEqual(
    sorted(snapshot.memberships.map(({ email, orgId }) => `${email}:${orgId}`)),
    sorted([
      `${expected.ownerEmail}:${alphaOrgId}`,
      `${expected.ownerEmail}:${betaOrgId}`,
      `${expected.memberEmail}:${alphaOrgId}`,
    ]),
    "membership grants crossed the qualified organization boundary",
  );

  const auditCounts = new Map(
    snapshot.audits.map(({ orgId, count }) => [orgId, Number(count)]),
  );
  assert.ok((auditCounts.get(alphaOrgId) ?? 0) > 0, "alpha audit trail is missing");
  assert.ok((auditCounts.get(betaOrgId) ?? 0) > 0, "beta audit trail is missing");

  return {
    organizationIds: {
      alpha: alphaOrgId,
      beta: betaOrgId,
    },
    identities: snapshot.identities.length,
    memberships: snapshot.memberships.length,
    workflows: snapshot.workflows.length,
    runs: snapshot.runs.length,
    credentials: snapshot.credentials.length,
    invitations: snapshot.invitations.length,
    configs: snapshot.configs.length,
  };
}
