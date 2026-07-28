/** Lifecycle wrapper for the persistent local Docker stack. */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ensureLocalCredentialMasterKey,
  ensureLocalEnv,
  getLocalStackSettings,
  localEnvFile,
} from "./local-env.mjs";
import {
  formatLocalStackStatus,
  inspectLocalSupabase,
} from "./local-stack-status.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const supabaseCli = fileURLToPath(new URL("../node_modules/supabase/dist/supabase.js", import.meta.url));
const composeFile = "deploy/local/compose.yml";
const command = process.argv[2] ?? "up";
const authProfile = process.argv.includes("--auth");
const authExclusions = [
  "realtime",
  "storage-api",
  "imgproxy",
  "postgres-meta",
  "studio",
  "edge-runtime",
  "logflare",
  "vector",
  "supavisor",
  "mailpit",
  "postgrest",
].join(",");
const placeholderDatabaseUrl = "postgres://unused:unused@127.0.0.1:1/postgres";
let composeEnvironment = {
  JANUSLY_LOCAL_DATABASE_URL: placeholderDatabaseUrl,
};

function run(commandName, args, options = {}) {
  return new Promise((resolve, reject) => {
    const capture = options.capture || options.sensitive;
    const child = spawn(commandName, args, {
      cwd: root,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: {
        ...process.env,
        // The local CLI is the only Supabase component that can emit usage
        // telemetry. The self-hosted containers themselves do not phone home.
        SUPABASE_TELEMETRY_DISABLED: "1",
        DO_NOT_TRACK: "1",
        ...composeEnvironment,
      },
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(
        `${commandName} ${args.join(" ")} exited ${code}${!options.sensitive && stderr ? `: ${stderr.trim()}` : ""}`,
      )));
  });
}

function runSupabase(args, options = {}) {
  return run(process.execPath, [supabaseCli, ...args], options);
}

function parseEnvOutput(output) {
  const values = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, raw] = match;
    const trimmed = raw.trim();
    values[key] = trimmed.startsWith('"') && trimmed.endsWith('"')
      ? JSON.parse(trimmed)
      : trimmed;
  }
  return values;
}

function containerUrl(raw) {
  const parsed = new URL(raw);
  parsed.hostname = "host.docker.internal";
  return parsed.toString();
}

async function readLocalSupabaseStatus() {
  const { stdout } = await runSupabase(["status", "-o", "env"], { sensitive: true });
  return parseEnvOutput(stdout);
}

function configureSupabaseEnvironment(status, { authEnabled }) {
  const databaseUrl = status.DB_URL;
  if (!databaseUrl) {
    throw new Error("Supabase local status did not expose DB_URL");
  }

  composeEnvironment = {
    JANUSLY_LOCAL_DATABASE_URL: containerUrl(databaseUrl),
    JANUSLY_LOCAL_ALLOW_DEV_AUTH_HEADERS: authEnabled ? "false" : "true",
  };

  if (!authEnabled) return;

  const apiUrl = status.API_URL;
  const anonKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY;
  const serviceRoleKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
  if (!apiUrl || !anonKey || !serviceRoleKey) {
    throw new Error("Supabase local status did not expose API_URL, an anonymous/publishable key, and a service-role/secret key");
  }
  const parsed = new URL(apiUrl);
  Object.assign(composeEnvironment, {
    JANUSLY_LOCAL_SUPABASE_PUBLIC_URL: apiUrl.replace("127.0.0.1", "localhost"),
    JANUSLY_LOCAL_SUPABASE_INTERNAL_URL: `http://host.docker.internal:${parsed.port}`,
    JANUSLY_LOCAL_SUPABASE_ANON_KEY: anonKey,
    JANUSLY_LOCAL_SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  });
}

async function startLocalSupabase({ authEnabled }) {
  // Supabase prints its local JWTs and secret keys even after a successful
  // start. Capture the output so routine lifecycle logs never disclose them.
  await runSupabase(["start", "-x", authExclusions], { sensitive: true });
  configureSupabaseEnvironment(await readLocalSupabaseStatus(), { authEnabled });
}

async function stopLocalSupabase({ reset = false } = {}) {
  await runSupabase(["stop", ...(reset ? ["--no-backup"] : [])]);
}

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
const settings = await getLocalStackSettings();

async function waitForStack() {
  await Promise.all([
    waitFor(`${settings.apiUrl}/health`),
    waitFor(`${settings.webUrl}/`),
    waitFor(`${settings.simulatorUrl}/health`),
  ]);
}

if (command === "up") {
  await startLocalSupabase({ authEnabled: authProfile });
  await compose(["up", "-d", "--build"]);
  try {
    await waitForStack();
    console.log(
      `[local] ready: web ${settings.webUrl} · api ${settings.apiUrl} · provider mode ${settings.simulatorEnabled ? "simulator" : "external"} · identity ${authProfile ? "supabase" : "dev-headers"}`,
    );
  } catch (error) {
    await compose(["logs", "--tail", "150"]);
    throw error;
  }
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
    configureSupabaseEnvironment(inspection.status, { authEnabled: authProfile });
  }
  await compose(["ps"]);
  console.log(formatLocalStackStatus(inspection, { authEnabled: authProfile }));
} else if (command === "fixtures") {
  configureSupabaseEnvironment(await readLocalSupabaseStatus(), { authEnabled: false });
  await compose([
    "run", "--rm", "--no-deps", "api",
    "pnpm", "--filter", "@janusly/api", "exec", "tsx",
    "../../scripts/setup-local-smoke-fixtures.ts",
  ]);
} else if (command === "recovery-lab-cleanup") {
  configureSupabaseEnvironment(await readLocalSupabaseStatus(), { authEnabled: false });
  await compose([
    "run", "--rm", "--no-deps", "api",
    "pnpm", "--filter", "@janusly/api", "exec", "tsx",
    "../../scripts/cleanup-local-recovery-lab.ts",
  ]);
} else if (command === "verify-db") {
  configureSupabaseEnvironment(await readLocalSupabaseStatus(), { authEnabled: authProfile });
  await compose([
    "run", "--rm", "--no-deps", "api",
    "pnpm", "--filter", "@janusly/api", "exec", "tsx",
    "../../scripts/verify-local-unified-db.ts",
    ...(process.argv.includes("--expect-empty") ? ["--expect-empty"] : []),
  ]);
} else if (command === "logs") {
  await compose(["logs", "-f", "--tail", "150"]);
} else {
  throw new Error("usage: node scripts/local-stack.mjs up|down|reset|restart|status|fixtures|recovery-lab-cleanup|verify-db|logs [--auth] [--expect-empty]");
}
