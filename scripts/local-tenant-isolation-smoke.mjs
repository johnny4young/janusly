/** Destructive local qualification of real identity and tenant boundaries. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCleanInstallRequest } from "./local-clean-install-policy.mjs";
import { getLocalStackSettings } from "./local-env.mjs";
import { runQualificationWithCleanup } from "./qualification-cleanup.mjs";
import { validateTenantIsolationSnapshot } from "./tenant-isolation-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidenceDirectory = process.env.JANUSLY_EVIDENCE_DIR
  ?? fileURLToPath(
    new URL(
      "../output/review/2026-07-30-tenant-isolation-qualification",
      import.meta.url,
    ),
  );
const stamp = `${Date.now().toString(36)}-${process.pid}`;
const qualified = {
  ownerEmail: `owner-${stamp}@tenant.janusly.test`,
  memberEmail: `member-${stamp}@tenant.janusly.test`,
  password: `Tenant-${stamp}-Identity!`,
  alpha: {
    name: `Tenant Alpha ${stamp}`,
    workflowId: `tenant-alpha-${stamp}`,
    workflowName: `Alpha workflow ${stamp}`,
    credentialName: `alpha-credential-${stamp}`,
    secret: `alpha-${crypto.randomUUID()}`,
    inviteEmail: `member-${stamp}@tenant.janusly.test`,
    timeoutMs: 4_100,
  },
  beta: {
    name: `Tenant Beta ${stamp}`,
    workflowId: `tenant-beta-${stamp}`,
    workflowName: `Beta workflow ${stamp}`,
    credentialName: `beta-credential-${stamp}`,
    secret: `beta-${crypto.randomUUID()}`,
    inviteEmail: `beta-only-${stamp}@tenant.janusly.test`,
    timeoutMs: 5_200,
  },
};
const identityEnvironment = {
  JANUSLY_TENANT_OWNER_EMAIL: qualified.ownerEmail,
  JANUSLY_TENANT_MEMBER_EMAIL: qualified.memberEmail,
  JANUSLY_TENANT_PASSWORD: qualified.password,
  JANUSLY_TENANT_ALPHA_NAME: qualified.alpha.name,
  JANUSLY_TENANT_BETA_NAME: qualified.beta.name,
  JANUSLY_TENANT_ALPHA_WORKFLOW_ID: qualified.alpha.workflowId,
  JANUSLY_TENANT_BETA_WORKFLOW_ID: qualified.beta.workflowId,
  JANUSLY_TENANT_ALPHA_WORKFLOW_NAME: qualified.alpha.workflowName,
  JANUSLY_TENANT_BETA_WORKFLOW_NAME: qualified.beta.workflowName,
  JANUSLY_TENANT_ALPHA_CREDENTIAL: qualified.alpha.credentialName,
  JANUSLY_TENANT_BETA_CREDENTIAL: qualified.beta.credentialName,
  JANUSLY_TENANT_ALPHA_SECRET: qualified.alpha.secret,
  JANUSLY_TENANT_BETA_SECRET: qualified.beta.secret,
  JANUSLY_TENANT_BETA_INVITE_EMAIL: qualified.beta.inviteEmail,
};
const screenshots = [
  "tenant-owner-beta-workflows-es.png",
  "tenant-owner-alpha-workflows-en.png",
  "tenant-owner-alpha-connections-en.png",
  "tenant-member-alpha-workflows-en.png",
];

assertCleanInstallRequest(["--auth", ...process.argv.slice(2)]);
await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
await chmod(evidenceDirectory, 0o700);

function run(command, argumentsList, extraEnvironment = {}, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argumentsList, {
      cwd: root,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, ...identityEnvironment, ...extraEnvironment },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolvePromise({ stdout, stderr })
      : reject(new Error(
        `${command} ${argumentsList.join(" ")} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
      )));
  });
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function readDatabaseSnapshot() {
  const organizationNames = [
    qualified.alpha.name,
    qualified.beta.name,
  ].map(sqlLiteral).join(", ");
  const workflowIds = [
    qualified.alpha.workflowId,
    qualified.beta.workflowId,
  ].map(sqlLiteral).join(", ");
  const credentialNames = [
    qualified.alpha.credentialName,
    qualified.beta.credentialName,
  ].map(sqlLiteral).join(", ");
  const invitationEmails = [
    qualified.alpha.inviteEmail,
    qualified.beta.inviteEmail,
  ].map(sqlLiteral).join(", ");
  const identityEmails = [
    qualified.ownerEmail,
    qualified.memberEmail,
  ].map(sqlLiteral).join(", ");

  const query = `WITH target_orgs AS (
    SELECT id, name FROM organizations WHERE name IN (${organizationNames})
  )
  SELECT json_build_object(
    'organizations', (
      SELECT coalesce(json_agg(json_build_object('id', id, 'name', name) ORDER BY name), '[]'::json)
      FROM target_orgs
    ),
    'workflows', (
      SELECT coalesce(json_agg(json_build_object('id', id, 'orgId', org_id) ORDER BY id), '[]'::json)
      FROM workflows WHERE id IN (${workflowIds})
    ),
    'runs', (
      SELECT coalesce(json_agg(json_build_object(
        'workflowId', coalesce(v.workflow_id, r.input_json -> 'workflow' ->> 'id', r.workflow_version_id),
        'orgId', r.org_id
      ) ORDER BY coalesce(v.workflow_id, r.input_json -> 'workflow' ->> 'id', r.workflow_version_id)), '[]'::json)
      FROM runs r
      LEFT JOIN workflow_versions v
        ON v.id = r.workflow_version_id
        AND v.org_id = r.org_id
      WHERE coalesce(v.workflow_id, r.input_json -> 'workflow' ->> 'id', r.workflow_version_id)
        IN (${workflowIds})
    ),
    'credentials', (
      SELECT coalesce(json_agg(json_build_object('name', name, 'orgId', org_id) ORDER BY name), '[]'::json)
      FROM credentials WHERE name IN (${credentialNames})
    ),
    'invitations', (
      SELECT coalesce(json_agg(json_build_object('email', email, 'orgId', org_id) ORDER BY email), '[]'::json)
      FROM invitations WHERE email IN (${invitationEmails})
    ),
    'configs', (
      SELECT coalesce(json_agg(json_build_object('orgId', org_id, 'value', value_json) ORDER BY org_id), '[]'::json)
      FROM org_configs
      WHERE org_id IN (SELECT id FROM target_orgs) AND key = 'http.timeoutMs'
    ),
    'identities', (
      SELECT coalesce(json_agg(json_build_object('email', email) ORDER BY email), '[]'::json)
      FROM auth.users WHERE email IN (${identityEmails})
    ),
    'memberships', (
      SELECT coalesce(json_agg(json_build_object('email', email, 'orgId', org_id) ORDER BY email, org_id), '[]'::json)
      FROM org_members
      WHERE org_id IN (SELECT id FROM target_orgs)
    ),
    'audits', (
      SELECT coalesce(json_agg(json_build_object('orgId', org_id, 'count', count) ORDER BY org_id), '[]'::json)
      FROM (
        SELECT org_id, count(*)::integer AS count
        FROM audit_logs
        WHERE org_id IN (SELECT id FROM target_orgs)
        GROUP BY org_id
      ) counts
    )
  )::text;`;

  const result = await run(
    "docker",
    [
      "exec",
      "supabase_db_janusly-local",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-Atqc",
      query,
    ],
    {},
    { capture: true },
  );
  const payload = result.stdout.trim();
  assert.ok(payload, "tenant-isolation database snapshot is missing");
  return JSON.parse(payload);
}

async function qualifyTenantIsolation() {
  await run(
    process.execPath,
    ["scripts/local-stack.mjs", "reset", "--auth"],
  );
  await run(
    process.execPath,
    ["scripts/local-stack.mjs", "up", "--auth"],
  );
  const settings = await getLocalStackSettings();
  await run(
    "pnpm",
    [
      "--filter", "@janusly/web", "exec", "playwright", "test",
      "e2e/local-tenant-isolation.spec.ts",
      "--project=chromium",
      "--workers=1",
    ],
    {
      JANUSLY_LOCAL_TENANT_ISOLATION_E2E: "1",
      JANUSLY_EVIDENCE_DIR: evidenceDirectory,
      JANUSLY_TENANT_API_URL: settings.apiUrl,
      PLAYWRIGHT_BASE_URL: settings.webUrl,
      PLAYWRIGHT_SKIP_WEB_SERVER: "1",
    },
  );

  const database = validateTenantIsolationSnapshot(
    await readDatabaseSnapshot(),
    qualified,
  );
  await Promise.all(
    screenshots.map((name) => chmod(join(evidenceDirectory, name), 0o600)),
  );

  return {
    qualifiedAt: new Date().toISOString(),
    runtime: { node: process.version },
    urls: { web: settings.webUrl, api: settings.apiUrl },
    topology: {
      identities: 2,
      organizations: 2,
      ownerMemberships: 2,
      memberMemberships: 1,
    },
    api: {
      tenantListsScoped: true,
      directWorkflowIdHidden: true,
      directRunIdHidden: true,
      credentialMutationScoped: true,
      invitationMutationScoped: true,
      forgedOrganizationHintRejected: true,
    },
    database,
    browser: {
      organizationSwitchClearsPriorData: true,
      memberSeesGrantedOrganizationOnly: true,
      permissionUiMatchesViewerGrant: true,
      bilingual: true,
      accessibility: true,
      overflow: false,
      runtimeErrors: false,
    },
    screenshots,
  };
}

const report = await runQualificationWithCleanup(
  qualifyTenantIsolation,
  () => run(
    process.execPath,
    ["scripts/local-stack.mjs", "reset", "--auth"],
  ),
  "tenant-isolation qualification",
);
report.cleanup = {
  localPersistentDataRemoved: true,
  stackStopped: true,
};

await writeFile(
  join(evidenceDirectory, "tenant-isolation-qualification.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
);
await writeFile(
  join(evidenceDirectory, "qualification-summary.md"),
  `# Local tenant-isolation qualification

- Two real Supabase identities exercise two organizations with one shared owner and one single-organization viewer.
- Workflows, runs, credentials, invitations, runtime configuration, members, and audit reads return only the selected organization.
- Direct identifiers from the other organization remain enumeration-safe and cannot be deleted, revoked, or fetched.
- A forged organization hint from the viewer is rejected because membership is the authority.
- Organization switching clears prior workflow/credential inventory from the UI; the viewer never receives a switch target for the ungranted organization.
- PostgreSQL independently proves every qualified row and membership is bound to the expected organization.
- Generated Auth/tenant data is removed and the local stack is stopped after success or failure.

## Key Learnings:

1. Tenant isolation must be proven at identity selection, list reads, direct-id reads, mutations, UI transitions, and database bindings rather than inferred from one header check.
2. An organization hint is only a scope selector; the persisted membership row remains the grant.
3. Cleanup is part of destructive qualification so synthetic tenant data never becomes the operator's starting state.
`,
  { mode: 0o600 },
);

console.log(`[local] tenant-isolation evidence: ${evidenceDirectory}`);
