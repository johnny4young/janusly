/** Lifecycle wrapper for the persistent local Docker stack. */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureLocalEnv, getLocalStackSettings, localEnvFile } from "./local-env.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
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
let composeEnvironment = {};

function run(commandName, args, options = {}) {
  return new Promise((resolve, reject) => {
    const capture = options.capture || options.sensitive;
    const child = spawn(commandName, args, {
      cwd: root,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, ...composeEnvironment },
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

async function startLocalAuth() {
  // Supabase prints its local JWTs and secret keys even after a successful
  // start. Capture the output so routine lifecycle logs never disclose them.
  await run("pnpm", ["exec", "supabase", "start", "-x", authExclusions], { sensitive: true });
  const { stdout } = await run(
    "pnpm",
    ["exec", "supabase", "status", "-o", "env"],
    { sensitive: true },
  );
  const status = parseEnvOutput(stdout);
  const apiUrl = status.API_URL;
  const anonKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY;
  const serviceRoleKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
  if (!apiUrl || !anonKey || !serviceRoleKey) {
    throw new Error("Supabase local status did not expose API_URL, an anonymous/publishable key, and a service-role/secret key");
  }
  const parsed = new URL(apiUrl);
  composeEnvironment = {
    JANUSLY_LOCAL_ALLOW_DEV_AUTH_HEADERS: "false",
    JANUSLY_LOCAL_SUPABASE_PUBLIC_URL: apiUrl.replace("127.0.0.1", "localhost"),
    JANUSLY_LOCAL_SUPABASE_INTERNAL_URL: `http://host.docker.internal:${parsed.port}`,
    JANUSLY_LOCAL_SUPABASE_ANON_KEY: anonKey,
    JANUSLY_LOCAL_SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  };
}

async function stopLocalAuth({ reset = false } = {}) {
  await run("pnpm", ["exec", "supabase", "stop", ...(reset ? ["--no-backup"] : [])]);
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
const settings = await getLocalStackSettings();

async function waitForStack() {
  await Promise.all([
    waitFor(`${settings.apiUrl}/health`),
    waitFor(`${settings.webUrl}/`),
    waitFor(`${settings.simulatorUrl}/health`),
  ]);
}

if (command === "up") {
  if (authProfile) await startLocalAuth();
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
  if (authProfile) await stopLocalAuth();
  console.log("[local] stopped; named volumes were preserved");
} else if (command === "reset") {
  await compose(["down", "-v", "--remove-orphans"]);
  if (authProfile) await stopLocalAuth({ reset: true });
  console.log("[local] stopped and persistent local data was removed");
} else if (command === "restart") {
  if (authProfile) await startLocalAuth();
  await compose(["restart", "postgres", "redis", "provider-simulator", "api", "worker", "web"]);
  await waitForStack();
  console.log("[local] restarted and healthy");
} else if (command === "status") {
  await compose(["ps"]);
  if (authProfile) {
    const { stdout } = await run(
      "pnpm",
      ["exec", "supabase", "status", "-o", "env"],
      { sensitive: true },
    );
    const status = parseEnvOutput(stdout);
    console.log(`[local] Supabase Auth ${status.API_URL ? `ready at ${status.API_URL}` : "running"}`);
  }
} else if (command === "logs") {
  await compose(["logs", "-f", "--tail", "150"]);
} else {
  throw new Error("usage: node scripts/local-stack.mjs up|down|reset|restart|status|logs [--auth]");
}
