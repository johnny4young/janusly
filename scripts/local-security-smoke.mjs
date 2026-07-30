/** Destructive local security qualification with real Auth, API, DB, and UI boundaries. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCleanInstallRequest } from "./local-clean-install-policy.mjs";
import { getLocalStackSettings } from "./local-env.mjs";
import { runQualificationWithCleanup } from "./qualification-cleanup.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidenceDirectory = process.env.JANUSLY_EVIDENCE_DIR
  ?? fileURLToPath(
    new URL("../output/review/2026-07-30-security-qualification", import.meta.url),
  );
const stamp = `${Date.now()}-${process.pid}`;
const credentialName = `security-managed-${stamp}`;
const secretValue = `security-value-${crypto.randomUUID()}`;
const identityEnvironment = {
  JANUSLY_SECURITY_EMAIL: `owner-${stamp}@security.janusly.test`,
  JANUSLY_SECURITY_PASSWORD: `Security-${stamp}-Identity!`,
  JANUSLY_SECURITY_ORG_NAME: `Security Lab ${stamp}`,
  JANUSLY_SECURITY_CREDENTIAL_NAME: credentialName,
  JANUSLY_SECURITY_SECRET_VALUE: secretValue,
};

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

async function inspectContainer(name) {
  const { stdout } = await run(
    "docker",
    ["inspect", name],
    {},
    { capture: true },
  );
  return JSON.parse(stdout)[0];
}

function safePortBindings(inspection) {
  return Object.entries(inspection.NetworkSettings.Ports ?? {})
    .flatMap(([containerPort, bindings]) => (bindings ?? []).map((binding) => ({
      container: inspection.Name.replace(/^\//u, ""),
      containerPort,
      hostIp: binding.HostIp,
      hostPort: binding.HostPort,
    })));
}

async function qualifySecurityBoundaries() {
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
      "e2e/local-security.spec.ts", "--project=chromium", "--workers=1",
    ],
    {
      JANUSLY_LOCAL_SECURITY_E2E: "1",
      JANUSLY_EVIDENCE_DIR: evidenceDirectory,
      JANUSLY_SECURITY_API_URL: settings.apiUrl,
      PLAYWRIGHT_BASE_URL: settings.webUrl,
      PLAYWRIGHT_SKIP_WEB_SERVER: "1",
    },
  );

  const [gateway, database, api, web] = await Promise.all([
    inspectContainer("supabase_kong_janusly-local"),
    inspectContainer("supabase_db_janusly-local"),
    inspectContainer("janusly-local-api-1"),
    inspectContainer("janusly-local-web-1"),
  ]);
  const publishedPorts = [gateway, database, api, web].flatMap(safePortBindings);
  assert.ok(publishedPorts.length >= 4, "expected Auth, DB, API, and web bindings");
  assert.deepEqual(
    [...new Set(publishedPorts.map(({ hostIp }) => hostIp))],
    ["127.0.0.1"],
  );

  const apiMounts = api.Mounts.map((mount) => mount.Destination);
  const webMounts = web.Mounts.map((mount) => mount.Destination);
  const webEnvironmentNames = web.Config.Env.map((entry) => entry.split("=")[0]);
  assert.ok(
    apiMounts.includes("/run/secrets/janusly_credential_master_key"),
    "API must receive the credential root key as a Docker secret",
  );
  assert.ok(
    !webMounts.some((destination) => destination.startsWith("/run/secrets")),
    "web must not mount server secrets",
  );
  assert.ok(
    !webEnvironmentNames.some((name) => /MASTER|SERVICE_ROLE|ANTHROPIC_API_KEY/u.test(name)),
    "web must not receive server-only environment keys",
  );

  const databaseSnapshotResult = await run(
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
      `SELECT json_build_object(
        'credential', row_to_json(c),
        'secretVersion', row_to_json(s),
        'auditMetadata', (
          SELECT coalesce(json_agg(a.metadata), '[]'::json)
          FROM audit_logs a
          WHERE a.target_id = c.id
        )
      )::text
      FROM credentials c
      JOIN credential_secret_versions s
        ON s.credential_id = c.id AND s.org_id = c.org_id
      WHERE c.name = '${credentialName.replaceAll("'", "''")}';`,
    ],
    {},
    { capture: true },
  );
  const snapshotText = databaseSnapshotResult.stdout.trim();
  assert.ok(snapshotText, "managed credential database snapshot is missing");
  assert.ok(!snapshotText.includes(secretValue), "plaintext secret reached PostgreSQL");
  const databaseSnapshot = JSON.parse(snapshotText);
  assert.match(databaseSnapshot.credential.secret_ref, /^janusly-secret:\/\//u);
  assert.ok(databaseSnapshot.secretVersion.ciphertext);
  assert.notEqual(databaseSnapshot.secretVersion.ciphertext, secretValue);

  const screenshots = [
    "security-login-en.png",
    "security-connections-en.png",
    "security-connections-es.png",
  ];
  await Promise.all(
    screenshots.map((name) => chmod(join(evidenceDirectory, name), 0o600)),
  );

  return {
    qualifiedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
    },
    urls: {
      web: settings.webUrl,
      api: settings.apiUrl,
    },
    network: {
      name: "janusly-local-loopback",
      publishedPorts,
      allLoopback: true,
    },
    authentication: {
      supabase: true,
      devHeadersRejected: true,
      invalidBearerRejected: true,
      ungrantedOrganizationRejected: true,
    },
    cors: {
      allowedOriginEchoed: true,
      foreignOriginOmitted: true,
      opaqueNullOriginOmitted: true,
    },
    credentials: {
      managedRows: 1,
      plaintextAbsentFromDatabase: true,
      plaintextAbsentFromApiAndUi: true,
      apiRootKeyMountedAsSecret: true,
      webHasNoServerSecretMount: true,
    },
    publicHealth: {
      bounded: true,
      secretsAbsent: true,
      queueDepthAbsent: true,
    },
    screenshots,
  };
}

const report = await runQualificationWithCleanup(
  qualifySecurityBoundaries,
  () => run(
    process.execPath,
    ["scripts/local-stack.mjs", "reset", "--auth"],
  ),
  "security qualification",
);
report.cleanup = {
  localPersistentDataRemoved: true,
  stackStopped: true,
};

await writeFile(
  join(evidenceDirectory, "security-qualification.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
);
await writeFile(
  join(evidenceDirectory, "qualification-summary.md"),
  `# Local security qualification

- Real Supabase Auth rejects unauthenticated, dev-header, invalid-bearer, and ungranted-organization requests.
- Auth, PostgreSQL, Janusly API, and web publish only on \`127.0.0.1\`.
- Credential plaintext enters once and is absent from API, UI, audit metadata, and PostgreSQL rows.
- The API receives its root key through a read-only Docker secret; web receives no server secret mount.
- Foreign and opaque \`null\` origins receive no credentialed CORS grant.
- Public health remains bounded and omits secret, Redis, queue-depth, and latency details.
- Browser evidence passed English/Spanish UI, blocking Axe rules, horizontal-overflow, console, page-error, and response-error checks.
- Generated tenant/Auth data is removed and the local stack is stopped even when qualification fails.

## Key Learnings:

1. A custom Docker bridge is not sufficient on every Docker Desktop release; effective HostIP must be inspected and corrected explicitly.
2. Denied CORS origins must omit the allow-origin header rather than return the literal \`null\` origin.
3. Secret-store qualification needs independent wire, UI, database, mount, and audit evidence.
`,
  { mode: 0o600 },
);

console.log(`[local] security evidence: ${evidenceDirectory}`);
