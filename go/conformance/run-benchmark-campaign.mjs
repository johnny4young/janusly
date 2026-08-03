#!/usr/bin/env node

// Execute repeated co-scheduled A/B k6 pairs. Candidate and frozen baseline
// receive separate task-owned PostgreSQL 18 instances and run the same
// scenarios concurrently, removing whole-suite timing and cache confounders.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, unlinkSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BENCHMARK_CAMPAIGN_POLICY_VERSION,
  evaluateBenchmarkCampaign,
  formatBenchmarkCampaign,
  MAX_BENCHMARK_SAMPLES,
  MIN_BENCHMARK_SAMPLES,
} from "./benchmark-campaign-policy.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const goRoot = resolve(scriptDir, "..");
const repoRoot = resolve(goRoot, "..");
const composeFile = resolve(scriptDir, "benchmark.compose.yml");
const baselineFile = resolve(scriptDir, "perf/campaign-baseline.json");

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

function git(args, options = {}) {
  return mustRun("git", args, { cwd: repoRoot, ...options });
}

function parseArgs(argv) {
  const options = {
    samples: MIN_BENCHMARK_SAMPLES,
    output: resolve(repoRoot, "artifacts/go-benchmark-campaign.json"),
    markdown: resolve(repoRoot, "artifacts/go-benchmark-campaign.md"),
    evidence: resolve(repoRoot, "artifacts/go-benchmark-campaign"),
    candidatePostgresPort: 4635,
    baselinePostgresPort: 4636,
    candidateApiPort: 4640,
    candidateInternalPort: 4641,
    baselineApiPort: 4642,
    baselineInternalPort: 4643,
  };
  for (const arg of argv) {
    if (arg.startsWith("--samples=")) options.samples = Number(arg.slice(10));
    else if (arg.startsWith("--output=")) options.output = resolve(process.cwd(), arg.slice(9));
    else if (arg.startsWith("--markdown=")) options.markdown = resolve(process.cwd(), arg.slice(11));
    else if (arg.startsWith("--evidence=")) options.evidence = resolve(process.cwd(), arg.slice(11));
    else if (arg.startsWith("--candidate-postgres-port=")) options.candidatePostgresPort = Number(arg.slice(26));
    else if (arg.startsWith("--baseline-postgres-port=")) options.baselinePostgresPort = Number(arg.slice(25));
    else if (arg.startsWith("--candidate-api-port=")) options.candidateApiPort = Number(arg.slice(21));
    else if (arg.startsWith("--candidate-internal-port=")) options.candidateInternalPort = Number(arg.slice(26));
    else if (arg.startsWith("--baseline-api-port=")) options.baselineApiPort = Number(arg.slice(20));
    else if (arg.startsWith("--baseline-internal-port=")) options.baselineInternalPort = Number(arg.slice(25));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.samples) || options.samples < MIN_BENCHMARK_SAMPLES || options.samples > MAX_BENCHMARK_SAMPLES) {
    throw new Error(`--samples must be an integer in [${MIN_BENCHMARK_SAMPLES}, ${MAX_BENCHMARK_SAMPLES}]`);
  }
  const ports = [
    options.candidatePostgresPort,
    options.baselinePostgresPort,
    options.candidateApiPort,
    options.candidateInternalPort,
    options.baselineApiPort,
    options.baselineInternalPort,
  ];
  if (ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535) || new Set(ports).size !== ports.length) {
    throw new Error("benchmark ports must be distinct integers in [1024, 65535]");
  }
  return options;
}

async function writeAtomic(path, body) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, body, { mode: 0o600 });
  await rename(temporary, path);
}

function compose(args, options = {}) {
  return run("docker", ["compose", "-f", composeFile, ...args], options);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const statusBefore = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (statusBefore) throw new Error(`benchmark campaign requires a clean worktree:\n${statusBefore}`);
  mustRun("k6", ["version"]);
  mustRun("docker", ["version", "--format", "{{.Server.Version}}"]);
  const composeEnv = {
    JANUSLY_BENCH_CANDIDATE_PG_PORT: String(options.candidatePostgresPort),
    JANUSLY_BENCH_BASELINE_PG_PORT: String(options.baselinePostgresPort),
  };
  const existing = compose(["ps", "--all", "--quiet"], { env: composeEnv });
  if (existing.status !== 0) throw new Error(`could not inspect benchmark compose project: ${existing.stderr || existing.stdout}`);
  if (existing.stdout.trim()) throw new Error("benchmark compose project already exists; refusing to adopt or remove it");

  const candidate = { commit: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]) };
  const baseline = JSON.parse(await readFile(baselineFile, "utf8"));
  if (!/^[0-9a-f]{40}$/u.test(baseline.sourceCommit ?? "") ||
      !/^[0-9a-f]{40}$/u.test(baseline.sourceTree ?? "")) {
    throw new Error("benchmark baseline requires exact 40-character commit and tree ids");
  }
  const baselineTree = git(["rev-parse", `${baseline.sourceCommit}^{tree}`]);
  if (baselineTree !== baseline.sourceTree) throw new Error("benchmark baseline commit/tree provenance is invalid");
  const ancestor = run("git", ["merge-base", "--is-ancestor", baseline.sourceCommit, candidate.commit]);
  if (ancestor.status !== 0) {
    throw new Error(ancestor.status === 1
      ? "benchmark baseline is not an ancestor of the candidate"
      : `could not verify benchmark baseline ancestry (exit ${ancestor.status})`);
  }
  const baselineWorktree = resolve("/tmp", `janusly-go-benchmark-baseline-${process.pid}`);
  const candidateBinary = resolve("/tmp", `janusly-go-benchmark-candidate-${process.pid}`);
  const baselineBinary = resolve("/tmp", `janusly-go-benchmark-baseline-bin-${process.pid}`);
  for (const scratchPath of [baselineWorktree, candidateBinary, baselineBinary]) {
    if (existsSync(scratchPath)) throw new Error(`benchmark scratch path already exists: ${scratchPath}`);
  }
  await mkdir(options.evidence, { recursive: true });

  const startedAt = new Date().toISOString();
  let ownsComposeProject = false;
  let ownsBaselineWorktree = false;
  const cleanup = () => {
    const issues = [];
    if (ownsComposeProject) {
      const stopped = compose(["down", "-v", "--remove-orphans"], { stdio: "inherit", env: composeEnv });
      if (stopped.status === 0) ownsComposeProject = false;
      else issues.push(`could not remove benchmark compose project (exit ${stopped.status})`);
    }
    if (ownsBaselineWorktree) {
      const removed = run("git", ["worktree", "remove", "--force", baselineWorktree], {
        cwd: repoRoot, stdio: "inherit",
      });
      if (removed.status === 0) ownsBaselineWorktree = false;
      else issues.push(`could not remove baseline worktree (exit ${removed.status})`);
    }
    for (const binary of [candidateBinary, baselineBinary]) {
      try {
        unlinkSync(binary);
      } catch (error) {
        if (error?.code !== "ENOENT") issues.push(`could not remove ${binary}: ${error.message}`);
      }
    }
    return issues;
  };
  const handleSignal = signal => {
    for (const cleanupIssue of cleanup()) console.error(`[benchmark-campaign] cleanup: ${cleanupIssue}`);
    process.kill(process.pid, signal);
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  const samples = [];
  let campaignError;
  let cleanupIssues = [];
  try {
    mustRun("git", ["worktree", "add", "--detach", baselineWorktree, baseline.sourceCommit], {
      cwd: repoRoot, stdio: "inherit",
    });
    ownsBaselineWorktree = true;
    mustRun("go", ["build", "-o", candidateBinary, "./cmd/api"], { cwd: goRoot, stdio: "inherit" });
    mustRun("go", ["build", "-o", baselineBinary, "./cmd/api"], {
      cwd: resolve(baselineWorktree, "go"), stdio: "inherit",
    });
    accessSync(candidateBinary, constants.X_OK);
    accessSync(baselineBinary, constants.X_OK);

    ownsComposeProject = true;
    const started = compose(["up", "-d", "--wait"], { stdio: "inherit", env: composeEnv });
    if (started.status !== 0) throw new Error(`benchmark PostgreSQL failed to start (${started.status})`);

    for (let index = 1; index <= options.samples; index += 1) {
      const pair = {
        candidate: {
          binary: candidateBinary,
          service: "candidate-postgres",
          postgresPort: options.candidatePostgresPort,
          summaryPath: resolve(options.evidence, `pair-${String(index).padStart(2, "0")}-candidate.json`),
        },
        baseline: {
          binary: baselineBinary,
          service: "baseline-postgres",
          postgresPort: options.baselinePostgresPort,
          summaryPath: resolve(options.evidence, `pair-${String(index).padStart(2, "0")}-baseline.json`),
        },
      };
      const database = `pair_${index}`;
      for (const side of ["candidate", "baseline"]) {
        mustRun("docker", ["compose", "-f", composeFile, "exec", "-T", pair[side].service,
          "createdb", "-U", "janusly", database], { stdio: "inherit", env: composeEnv });
        const databaseURL = `postgres://janusly:janusly-go-benchmark@127.0.0.1:${pair[side].postgresPort}/${database}`;
        mustRun(pair[side].binary, ["migrate"], {
          stdio: "inherit", env: { JANUSLY_GO_DATABASE_URL: databaseURL },
        });
        pair[side].databaseURL = databaseURL;
      }

      process.stdout.write(`\n== co-scheduled benchmark pair ${index}/${options.samples} ==\n`);
      mustRun(process.execPath, [resolve(scriptDir, "run-bench-ab.mjs")], {
        cwd: repoRoot,
        stdio: "inherit",
        env: {
          BENCH_CANDIDATE_BINARY: pair.candidate.binary,
          BENCH_CANDIDATE_DATABASE_URL: pair.candidate.databaseURL,
          BENCH_CANDIDATE_COMMIT: candidate.commit,
          BENCH_CANDIDATE_API_PORT: String(options.candidateApiPort),
          BENCH_CANDIDATE_INTERNAL_PORT: String(options.candidateInternalPort),
          BENCH_CANDIDATE_SUMMARY_PATH: relative(repoRoot, pair.candidate.summaryPath),
          BENCH_BASELINE_BINARY: pair.baseline.binary,
          BENCH_BASELINE_DATABASE_URL: pair.baseline.databaseURL,
          BENCH_BASELINE_COMMIT: baseline.sourceCommit,
          BENCH_BASELINE_API_PORT: String(options.baselineApiPort),
          BENCH_BASELINE_INTERNAL_PORT: String(options.baselineInternalPort),
          BENCH_BASELINE_SUMMARY_PATH: relative(repoRoot, pair.baseline.summaryPath),
        },
      });
      const [candidateRaw, baselineRaw] = await Promise.all([
        readFile(pair.candidate.summaryPath), readFile(pair.baseline.summaryPath),
      ]);
      samples.push({
        index,
        execution: "concurrent",
        candidate,
        baseline: { commit: baseline.sourceCommit, tree: baseline.sourceTree },
        capturedAt: new Date().toISOString(),
        candidateSummarySha256: createHash("sha256").update(candidateRaw).digest("hex"),
        baselineSummarySha256: createHash("sha256").update(baselineRaw).digest("hex"),
        candidateSummary: JSON.parse(candidateRaw.toString("utf8")),
        baselineSummary: JSON.parse(baselineRaw.toString("utf8")),
      });
    }
  } catch (error) {
    campaignError = error;
  } finally {
    cleanupIssues = cleanup();
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }
  if (campaignError || cleanupIssues.length > 0) {
    const errors = [campaignError, ...cleanupIssues.map(message => new Error(message))].filter(Boolean);
    throw errors.length === 1 ? errors[0] : new AggregateError(errors, "benchmark campaign or cleanup failed");
  }

  const finalCommit = git(["rev-parse", "HEAD"]);
  const finalTree = git(["rev-parse", "HEAD^{tree}"]);
  const statusAfter = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const sourceTreeUnchanged = finalCommit === candidate.commit && finalTree === candidate.tree && statusAfter === "";
  const verdict = evaluateBenchmarkCampaign({ candidate, baseline, samples, sourceTreeUnchanged });
  const receipt = {
    schemaVersion: 1,
    policyVersion: BENCHMARK_CAMPAIGN_POLICY_VERSION,
    candidate,
    baseline: { id: baseline.id, sourceCommit: baseline.sourceCommit, sourceTree: baseline.sourceTree },
    startedAt,
    finishedAt: new Date().toISOString(),
    sourceTreeUnchanged,
    samples,
    ...verdict,
  };
  await writeAtomic(options.output, `${JSON.stringify(receipt, null, 2)}\n`);
  await writeAtomic(options.markdown, formatBenchmarkCampaign(receipt));
  process.stdout.write(`\nBenchmark receipt: ${options.output}\nBenchmark report: ${options.markdown}\n`);
  process.stdout.write(`Repeated A/B benchmark: ${receipt.pass ? "PASS" : "FAIL"}\n`);
  if (!receipt.pass) process.exitCode = 2;
}

main().catch(error => {
  console.error(`[benchmark-campaign] ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
