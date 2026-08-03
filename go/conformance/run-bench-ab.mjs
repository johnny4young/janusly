#!/usr/bin/env node

// Boot one exact candidate and one frozen baseline concurrently, run the
// co-scheduled k6 A/B scenario, and stop both processes before returning.

import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function port(name) {
  const value = Number(required(name));
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be an integer in [1024, 65535]`);
  }
  return value;
}

const candidate = {
  binary: required("BENCH_CANDIDATE_BINARY"),
  databaseURL: required("BENCH_CANDIDATE_DATABASE_URL"),
  commit: required("BENCH_CANDIDATE_COMMIT"),
  apiPort: port("BENCH_CANDIDATE_API_PORT"),
  internalPort: port("BENCH_CANDIDATE_INTERNAL_PORT"),
};
const baseline = {
  binary: required("BENCH_BASELINE_BINARY"),
  databaseURL: required("BENCH_BASELINE_DATABASE_URL"),
  commit: required("BENCH_BASELINE_COMMIT"),
  apiPort: port("BENCH_BASELINE_API_PORT"),
  internalPort: port("BENCH_BASELINE_INTERNAL_PORT"),
};
const ports = [candidate.apiPort, candidate.internalPort, baseline.apiPort, baseline.internalPort];
if (new Set(ports).size !== ports.length) throw new Error("A/B API and internal ports must be distinct");
for (const side of [candidate, baseline]) {
  if (!isAbsolute(side.binary)) throw new Error("A/B benchmark binary paths must be absolute");
  if (!/^[0-9a-f]{40}$/u.test(side.commit)) throw new Error("A/B benchmark commits must be exact Git object ids");
  accessSync(side.binary, constants.X_OK);
}

const candidateSummary = required("BENCH_CANDIDATE_SUMMARY_PATH");
const baselineSummary = required("BENCH_BASELINE_SUMMARY_PATH");
const processes = [];

function boot(side) {
  const child = spawn(side.binary, [], {
    env: {
      ...process.env,
      JANUSLY_GO_DATABASE_URL: side.databaseURL,
      JANUSLY_GO_WORK_PLANE_ENABLED: "true",
      JANUSLY_GO_PORT: String(side.apiPort),
      JANUSLY_GO_INTERNAL_HOST: "127.0.0.1",
      JANUSLY_GO_INTERNAL_PORT: String(side.internalPort),
      JANUSLY_GO_POLL_MS: "50",
      OTEL_EXPORTER: "none",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  processes.push(child);
  return child;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  try { child.kill("SIGTERM"); } catch { return; }
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    const killed = once(child, "exit");
    try { child.kill("SIGKILL"); } catch { return; }
    await killed;
  }
}

async function waitForHealthy(side, child) {
  const health = `http://127.0.0.1:${side.apiPort}/healthz`;
  for (let attempt = 0; attempt <= 50; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${side.commit} exited before becoming healthy`);
    }
    try {
      const response = await fetch(health);
      if (response.ok) return;
    } catch { /* booting */ }
    await delay(200);
  }
  throw new Error(`${side.commit} never became healthy`);
}

const stopOnExit = () => {
  for (const child of processes) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
};
process.on("exit", stopOnExit);

const candidateProcess = boot(candidate);
const baselineProcess = boot(baseline);
try {
  await Promise.all([
    waitForHealthy(candidate, candidateProcess),
    waitForHealthy(baseline, baselineProcess),
  ]);
  execFileSync("k6", ["run", "--quiet", "go/conformance/perf/k6-bench-ab.js"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      BENCH_CANDIDATE_BASE: `http://127.0.0.1:${candidate.apiPort}`,
      BENCH_BASELINE_BASE: `http://127.0.0.1:${baseline.apiPort}`,
      BENCH_RUN_ID: Date.now().toString(36),
      BENCH_CANDIDATE_SUMMARY_PATH: candidateSummary,
      BENCH_BASELINE_SUMMARY_PATH: baselineSummary,
    },
  });
} finally {
  await Promise.all(processes.map(stop));
}

const candidateResult = JSON.parse(readFileSync(resolve(repoRoot, candidateSummary), "utf8"));
const baselineResult = JSON.parse(readFileSync(resolve(repoRoot, baselineSummary), "utf8"));
console.log(JSON.stringify({
  candidate: { commit: candidate.commit, summary: candidateResult },
  baseline: { commit: baseline.commit, summary: baselineResult },
}));
