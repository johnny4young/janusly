/** Shared lifecycle and environment boundary for the local Supabase runtime. */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rebindPublishedContainerToLoopback } from "./docker-loopback.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const supabaseCli = fileURLToPath(
  new URL("../node_modules/supabase/dist/supabase.js", import.meta.url),
);
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
export const localSupabaseNetwork = "janusly-local-loopback";
const loopbackBindingOption = "com.docker.network.bridge.host_binding_ipv4";
const publishedContainerNames = [
  "supabase_kong_janusly-local",
  "supabase_db_janusly-local",
];

export const localPlaceholderDatabaseUrl =
  "postgres://unused:unused@127.0.0.1:1/postgres";

function runSupabase(argumentsList, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const capture = options.capture || options.sensitive;
    const child = spawn(process.execPath, [supabaseCli, ...argumentsList], {
      cwd: root,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: {
        ...process.env,
        SUPABASE_TELEMETRY_DISABLED: "1",
        DO_NOT_TRACK: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolvePromise({ stdout, stderr })
      : reject(new Error(
        `${process.execPath} ${supabaseCli} ${argumentsList.join(" ")} exited ${code}${!options.sensitive && stderr ? `: ${stderr.trim()}` : ""}`,
      )));
  });
}

function runDocker(argumentsList, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", argumentsList, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || options.allowFailure) {
        resolvePromise({ code, stdout, stderr });
        return;
      }
      reject(new Error(
        `docker ${argumentsList.join(" ")} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
      ));
    });
  });
}

export function assertLoopbackNetworkBinding(value) {
  if (value.trim() !== "127.0.0.1") {
    throw new Error(
      `${localSupabaseNetwork} must set ${loopbackBindingOption}=127.0.0.1`,
    );
  }
}

export function isMissingDockerNetworkError(value) {
  return /(?:No such network|network .+ not found)/u.test(value);
}

export function findUnsafePublishedBindings(inspections) {
  const unsafe = [];
  for (const inspection of inspections) {
    for (const [containerPort, bindings] of Object.entries(
      inspection.ports ?? {},
    )) {
      for (const binding of bindings ?? []) {
        if (binding.HostIp !== "127.0.0.1") {
          unsafe.push({
            container: inspection.container,
            containerPort,
            hostIp: binding.HostIp,
            hostPort: binding.HostPort,
          });
        }
      }
    }
  }
  return unsafe;
}

async function ensureLocalSupabaseNetwork() {
  const inspected = await runDocker([
    "network",
    "inspect",
    "--format",
    `{{ index .Options "${loopbackBindingOption}" }}`,
    localSupabaseNetwork,
  ], { allowFailure: true });

  if (inspected.code === 0) {
    assertLoopbackNetworkBinding(inspected.stdout);
    return;
  }
  if (!isMissingDockerNetworkError(inspected.stderr)) {
    throw new Error(
      `Unable to inspect the local Supabase Docker network: ${inspected.stderr.trim()}`,
    );
  }

  await runDocker([
    "network",
    "create",
    "--driver",
    "bridge",
    "--opt",
    `${loopbackBindingOption}=127.0.0.1`,
    localSupabaseNetwork,
  ]);
  const created = await runDocker([
    "network",
    "inspect",
    "--format",
    `{{ index .Options "${loopbackBindingOption}" }}`,
    localSupabaseNetwork,
  ]);
  assertLoopbackNetworkBinding(created.stdout);
}

async function inspectPublishedBindings() {
  return Promise.all(publishedContainerNames.map(async (container) => {
    const result = await runDocker([
      "inspect",
      "--format",
      "{{json .NetworkSettings.Ports}}",
      container,
    ]);
    return {
      container,
      ports: JSON.parse(result.stdout.trim()),
    };
  }));
}

async function assertLocalSupabasePortBindings() {
  const inspections = await inspectPublishedBindings();
  for (const inspection of inspections) {
    const bindings = Object.values(inspection.ports ?? {}).flatMap(
      (portBindings) => portBindings ?? [],
    );
    if (bindings.length === 0) {
      throw new Error(
        `Local Supabase container ${inspection.container} has no published port`,
      );
    }
  }
  const unsafe = findUnsafePublishedBindings(inspections);
  if (unsafe.length > 0) {
    throw new Error(
      `Local Supabase published a non-loopback port: ${unsafe
        .map(({ container, hostIp, hostPort }) => `${container} ${hostIp}:${hostPort}`)
        .join(", ")}`,
    );
  }
}

export function parseSupabaseEnvironmentOutput(output) {
  const values = {};
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
    if (!match) continue;
    const [, key, raw] = match;
    const trimmed = raw.trim();
    values[key] = trimmed.startsWith("\"") && trimmed.endsWith("\"")
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

export function buildLocalComposeEnvironment(status, { authEnabled }) {
  const databaseUrl = status.DB_URL;
  if (!databaseUrl) {
    throw new Error("Supabase local status did not expose DB_URL");
  }

  const environment = {
    JANUSLY_LOCAL_DATABASE_URL: containerUrl(databaseUrl),
    JANUSLY_LOCAL_ALLOW_DEV_AUTH_HEADERS: authEnabled ? "false" : "true",
  };
  if (!authEnabled) return environment;

  const apiUrl = status.API_URL;
  const anonKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY;
  const serviceRoleKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
  if (!apiUrl || !anonKey || !serviceRoleKey) {
    throw new Error(
      "Supabase local status did not expose API_URL, an anonymous/publishable key, and a service-role/secret key",
    );
  }
  const parsed = new URL(apiUrl);
  return {
    ...environment,
    JANUSLY_LOCAL_SUPABASE_PUBLIC_URL: apiUrl.replace("127.0.0.1", "localhost"),
    JANUSLY_LOCAL_SUPABASE_INTERNAL_URL: `http://host.docker.internal:${parsed.port}`,
    JANUSLY_LOCAL_SUPABASE_ANON_KEY: anonKey,
    JANUSLY_LOCAL_SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  };
}

export async function readLocalSupabaseStatus() {
  const { stdout } = await runSupabase(["status", "-o", "env"], {
    sensitive: true,
  });
  return parseSupabaseEnvironmentOutput(stdout);
}

export async function startLocalSupabase({ authEnabled }) {
  await ensureLocalSupabaseNetwork();
  const startArguments = [
    "start",
    "--network-id",
    localSupabaseNetwork,
    "-x",
    authExclusions,
  ];
  await runSupabase(startArguments, { sensitive: true });
  try {
    await assertLocalSupabasePortBindings();
  } catch {
    for (const containerName of publishedContainerNames) {
      await rebindPublishedContainerToLoopback(containerName);
    }
    await assertLocalSupabasePortBindings();
  }
  return buildLocalComposeEnvironment(
    await readLocalSupabaseStatus(),
    { authEnabled },
  );
}

export async function stopLocalSupabase({ reset = false } = {}) {
  await runSupabase(["stop", ...(reset ? ["--no-backup"] : [])]);
}
