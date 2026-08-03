#!/usr/bin/env node

// Run the Go-only browser qualification against a task-owned PostgreSQL 18
// project and private ports. Never adopt, mutate, or stop the persistent pilot
// database used by developers or other validation lanes.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const goRoot = resolve(scriptDir, "..");
const repoRoot = resolve(goRoot, "..");
const composeFile = resolve(scriptDir, "web-qualification.compose.yml");
const projectPrefix = "janusly-go-web-qualification";

export function webQualificationProjectName(pid = process.pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("qualification process id must be a positive integer");
  return `${projectPrefix}-${pid}`;
}

function port(env, name, fallback) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be an integer in [1024, 65535]`);
  }
  return value;
}

export function parseWebQualificationPorts(env = process.env) {
  const ports = {
    postgres: port(env, "JANUSLY_GO_WEB_QUALIFICATION_PG_PORT", 4637),
    api: port(env, "JANUSLY_GO_WEB_QUALIFICATION_API_PORT", 4650),
    internal: port(env, "JANUSLY_GO_WEB_QUALIFICATION_INTERNAL_PORT", 4651),
  };
  if (new Set(Object.values(ports)).size !== 3) {
    throw new Error("Go web qualification PostgreSQL, API, and internal ports must be distinct");
  }
  return ports;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
}

function mustRun(command, args, options = {}) {
  const child = run(command, args, options);
  if (child.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${child.status}): ${child.stderr || child.stdout}`);
  }
  return (child.stdout ?? "").trim();
}

function compose(projectName, args, options = {}) {
  return run("docker", ["compose", "-p", projectName, "-f", composeFile, ...args], options);
}

async function main() {
  const ports = parseWebQualificationPorts();
  const projectName = webQualificationProjectName();
  mustRun("docker", ["version", "--format", "{{.Server.Version}}"]);
  const composeEnv = { JANUSLY_GO_WEB_QUALIFICATION_PG_PORT: String(ports.postgres) };
  const existing = compose(projectName, ["ps", "--all", "--quiet"], { env: composeEnv });
  if (existing.status !== 0) {
    throw new Error(`could not inspect Go web qualification project: ${existing.stderr || existing.stdout}`);
  }
  if (existing.stdout.trim()) {
    throw new Error("Go web qualification project already exists; refusing to adopt or remove it");
  }

  const databaseURL = `postgres://janusly:janusly-go-web-qualification@127.0.0.1:${ports.postgres}/janusly_go`;
  let ownsComposeProject = false;
  const cleanup = () => {
    if (!ownsComposeProject) return [];
    const stopped = compose(projectName, ["down", "-v", "--remove-orphans"], {
      stdio: "inherit",
      env: composeEnv,
    });
    if (stopped.status !== 0) {
      return [`could not remove Go web qualification project (exit ${stopped.status})`];
    }
    ownsComposeProject = false;
    return [];
  };
  const handleSignal = signal => {
    for (const issue of cleanup()) console.error(`[go-web-qualification] cleanup: ${issue}`);
    process.kill(process.pid, signal);
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  let qualificationError;
  let cleanupIssues = [];
  try {
    ownsComposeProject = true;
    const started = compose(projectName, ["up", "-d", "--wait"], { stdio: "inherit", env: composeEnv });
    if (started.status !== 0) throw new Error(`Go web qualification PostgreSQL failed to start (${started.status})`);
    mustRun("go", ["run", "./cmd/api", "migrate"], {
      cwd: goRoot,
      stdio: "inherit",
      env: { JANUSLY_GO_DATABASE_URL: databaseURL },
    });
    mustRun(process.execPath, [resolve(scriptDir, "run-web-smoke.mjs")], {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        JANUSLY_GO_DATABASE_URL: databaseURL,
        JANUSLY_GO_PG_CONTAINER: `${projectName}-postgres-1`,
        JANUSLY_GO_PG_DATABASE: "janusly_go",
        JANUSLY_GO_SMOKE_SKIP_PRECLEAN: "true",
        JANUSLY_GO_SMOKE_API_PORT: String(ports.api),
        JANUSLY_GO_SMOKE_INTERNAL_PORT: String(ports.internal),
      },
    });
  } catch (error) {
    qualificationError = error;
  } finally {
    cleanupIssues = cleanup();
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }
  if (qualificationError || cleanupIssues.length > 0) {
    const errors = [qualificationError, ...cleanupIssues.map(message => new Error(message))].filter(Boolean);
    throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Go web qualification or cleanup failed");
  }
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  main().catch(error => {
    console.error(`[go-web-qualification] ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  });
}
