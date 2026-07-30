/** Lifecycle wrapper for the persistent local Docker stack. */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ensureLocalCredentialMasterKey,
  ensureLocalEnv,
  getLocalStackSettings,
  localEnvFile,
  removeLocalGeneratedConfiguration,
} from "./local-env.mjs";
import { assertCleanInstallRequest } from "./local-clean-install-policy.mjs";
import {
  buildLocalComposeEnvironment,
  localPlaceholderDatabaseUrl,
  readLocalSupabaseStatus,
  startLocalSupabase,
  stopLocalSupabase,
} from "./local-supabase.mjs";
import {
  formatLocalStackStatus,
  inspectLocalSupabase,
} from "./local-stack-status.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const composeFile = "deploy/local/compose.yml";
const command = process.argv[2] ?? "up";
const authProfile = process.argv.includes("--auth");
let composeEnvironment = {
  JANUSLY_LOCAL_DATABASE_URL: localPlaceholderDatabaseUrl,
};

function compose(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", "--env-file", localEnvFile, "-f", composeFile, ...args], {
      cwd: root,
      stdio: options.stdio ?? "inherit",
      env: { ...process.env, ...composeEnvironment },
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`docker compose ${args.join(" ")} exited ${code}`)));
  });
}

async function waitFor(url, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw lastError ?? new Error(`${url} did not become ready`);
}

await ensureLocalEnv();
await ensureLocalCredentialMasterKey();
let settings = await getLocalStackSettings();

async function waitForStack() {
  await Promise.all([
    waitFor(`${settings.apiUrl}/health`),
    waitFor(`${settings.webUrl}/`),
    waitFor(`${settings.simulatorUrl}/health`),
  ]);
}

async function startStack({ authEnabled }) {
  composeEnvironment = await startLocalSupabase({ authEnabled });
  await compose(["up", "-d", "--build"]);
  try {
    await waitForStack();
  } catch (error) {
    await compose(["logs", "--tail", "150"]);
    throw error;
  }
}

async function verifyUnifiedDatabase(expectation) {
  composeEnvironment = buildLocalComposeEnvironment(
    await readLocalSupabaseStatus(),
    { authEnabled: authProfile },
  );
  await compose([
    "run", "--rm", "--no-deps", "api",
    "pnpm", "--filter", "@janusly/api", "exec", "tsx",
    "../../scripts/verify-local-unified-db.ts",
    ...(expectation === "empty" ? ["--expect-empty"] : []),
    ...(expectation === "onboarding" ? ["--expect-onboarding"] : []),
  ]);
}

if (command === "up") {
  await startStack({ authEnabled: authProfile });
  console.log(
    `[local] ready: web ${settings.webUrl} · api ${settings.apiUrl} · provider mode ${settings.simulatorEnabled ? "simulator" : "external"} · identity ${authProfile ? "supabase" : "dev-headers"}`,
  );
} else if (command === "clean-install") {
  assertCleanInstallRequest(process.argv.slice(3));
  await compose(["down", "-v", "--remove-orphans"]);
  await stopLocalSupabase({ reset: true });
  await removeLocalGeneratedConfiguration();
  await ensureLocalEnv();
  await ensureLocalCredentialMasterKey();
  settings = await getLocalStackSettings();
  await startStack({ authEnabled: true });
  await verifyUnifiedDatabase("empty");
  console.log(
    `[local] clean installation ready: web ${settings.webUrl} · api ${settings.apiUrl} · identity supabase · database empty`,
  );
} else if (command === "down") {
  await compose(["down"]);
  await stopLocalSupabase();
  console.log("[local] stopped; named volumes were preserved");
} else if (command === "reset") {
  await compose(["down", "-v", "--remove-orphans"]);
  await stopLocalSupabase({ reset: true });
  console.log("[local] stopped and persistent local data was removed");
} else if (command === "restart") {
  await startLocalSupabase({ authEnabled: authProfile });
  await compose(["restart", "redis", "provider-simulator", "api", "worker", "web"]);
  await waitForStack();
  console.log("[local] restarted and healthy");
} else if (command === "status") {
  const inspection = await inspectLocalSupabase(readLocalSupabaseStatus);
  if (inspection.status) {
    composeEnvironment = buildLocalComposeEnvironment(
      inspection.status,
      { authEnabled: authProfile },
    );
  }
  await compose(["ps"]);
  console.log(formatLocalStackStatus(inspection, { authEnabled: authProfile }));
} else if (command === "fixtures") {
  composeEnvironment = buildLocalComposeEnvironment(
    await readLocalSupabaseStatus(),
    { authEnabled: false },
  );
  await compose([
    "run", "--rm", "--no-deps", "api",
    "pnpm", "--filter", "@janusly/api", "exec", "tsx",
    "../../scripts/setup-local-smoke-fixtures.ts",
  ]);
} else if (command === "recovery-lab-cleanup") {
  composeEnvironment = buildLocalComposeEnvironment(
    await readLocalSupabaseStatus(),
    { authEnabled: false },
  );
  await compose([
    "run", "--rm", "--no-deps", "api",
    "pnpm", "--filter", "@janusly/api", "exec", "tsx",
    "../../scripts/cleanup-local-recovery-lab.ts",
  ]);
} else if (command === "verify-db") {
  await verifyUnifiedDatabase(
    process.argv.includes("--expect-empty")
      ? "empty"
      : process.argv.includes("--expect-onboarding")
        ? "onboarding"
        : "topology",
  );
} else if (command === "logs") {
  await compose(["logs", "-f", "--tail", "150"]);
} else {
  throw new Error("usage: node scripts/local-stack.mjs up|clean-install|down|reset|restart|status|fixtures|recovery-lab-cleanup|verify-db|logs [--auth] [--confirm-reset] [--expect-empty|--expect-onboarding]");
}
