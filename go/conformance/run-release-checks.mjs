#!/usr/bin/env node

// Execute the complete local review ladder against one clean candidate and
// emit ignored, commit/tree-bound receipts. External review and traffic gates
// are deliberately outside this command.

import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NODE_ORACLE_COMMIT } from "./queue-handoff-policy.mjs";
import { BENCHMARK_CAMPAIGN_POLICY_VERSION, MIN_BENCHMARK_SAMPLES } from "./benchmark-campaign-policy.mjs";
import { validateReleaseArtifactManifest } from "./release-artifact-policy.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const goRoot = resolve(scriptDir, "..");
const repoRoot = resolve(goRoot, "..");

const commands = Object.freeze([
  { id: "root_lint", command: "pnpm", args: ["lint"], cwd: repoRoot },
  { id: "root_scripts", command: "pnpm", args: ["test:scripts"], cwd: repoRoot },
  { id: "root_contract", command: "pnpm", args: ["contract:check"], cwd: repoRoot },
  { id: "root_build", command: "pnpm", args: ["build"], cwd: repoRoot },
  { id: "root_test", command: "pnpm", args: ["test"], cwd: repoRoot },
  { id: "root_integration_pg18", command: "pnpm", args: ["test:integration"], cwd: repoRoot },
  { id: "go_ci_pg18", command: "make", args: ["ci"], cwd: goRoot },
  { id: "go_revalidation_pg18", command: "make", args: ["test-pg18"], cwd: goRoot },
]);

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
}

function git(args) {
  const child = run("git", args);
  if (child.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${child.stderr || child.stdout}`);
  return child.stdout.trim();
}

function display(command, args) {
  return [command, ...args].join(" ");
}

async function writeAtomic(path, body) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, body, { mode: 0o600 });
  await rename(temporary, path);
}

function parseArgs(argv) {
  const options = {
    output: resolve(repoRoot, "artifacts/go-release-checks.json"),
    artifact: resolve(repoRoot, "artifacts/go-release/native/manifest.json"),
    queue: resolve(repoRoot, "artifacts/go-queue-handoff-evidence.json"),
    benchmark: resolve(repoRoot, "artifacts/go-benchmark-campaign.json"),
    benchmarkMarkdown: resolve(repoRoot, "artifacts/go-benchmark-campaign.md"),
  };
  for (const arg of argv) {
    if (arg.startsWith("--output=")) options.output = resolve(process.cwd(), arg.slice(9));
    else if (arg.startsWith("--artifact=")) options.artifact = resolve(process.cwd(), arg.slice(11));
    else if (arg.startsWith("--queue=")) options.queue = resolve(process.cwd(), arg.slice(8));
    else if (arg.startsWith("--benchmark=")) options.benchmark = resolve(process.cwd(), arg.slice(12));
    else if (arg.startsWith("--benchmark-markdown=")) options.benchmarkMarkdown = resolve(process.cwd(), arg.slice(21));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const statusBefore = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (statusBefore) throw new Error(`release checks require a clean worktree:\n${statusBefore}`);

  const candidate = {
    commit: git(["rev-parse", "HEAD"]),
    tree: git(["rev-parse", "HEAD^{tree}"]),
  };
  const receipt = {
    schemaVersion: 1,
    candidate,
    startedAt: new Date().toISOString(),
    checks: {},
  };

  for (const check of commands) {
    const label = display(check.command, check.args);
    process.stdout.write(`\n== ${check.id}: ${label} ==\n`);
    const started = Date.now();
    const child = run(check.command, check.args, { cwd: check.cwd, stdio: "inherit" });
    receipt.checks[check.id] = {
      pass: child.status === 0,
      command: label,
      exitCode: child.status,
      durationMs: Date.now() - started,
    };
  }

  process.stdout.write("\n== go_release_artifact: exact native binary provenance ==\n");
  const artifactStarted = Date.now();
  const artifactOutputDir = dirname(options.artifact);
  const artifactChild = run("make", [
    "release-artifact",
    `RELEASE_ARTIFACT_OUTPUT_DIR=${artifactOutputDir}`,
  ], { cwd: goRoot, stdio: "inherit" });
  let artifactSummary = null;
  let artifactError = null;
  if (artifactChild.status === 0) {
    try {
      const artifactManifest = JSON.parse(await readFile(options.artifact, "utf8"));
      artifactSummary = validateReleaseArtifactManifest(artifactManifest, candidate);
    } catch (error) {
      artifactError = error instanceof Error ? error.message : String(error);
    }
  }
  receipt.checks.go_release_artifact = {
    pass: artifactChild.status === 0 && artifactSummary !== null,
    command: "make release-artifact",
    exitCode: artifactChild.status,
    durationMs: Date.now() - artifactStarted,
    manifest: options.artifact,
    summary: artifactSummary,
    error: artifactError,
  };

  process.stdout.write("\n== go_benchmark_campaign: five co-scheduled isolated PostgreSQL 18 A/B pairs ==\n");
  const benchmarkStarted = Date.now();
  const benchmarkArgs = [
    resolve(scriptDir, "run-benchmark-campaign.mjs"),
    `--samples=${MIN_BENCHMARK_SAMPLES}`,
    `--output=${options.benchmark}`,
    `--markdown=${options.benchmarkMarkdown}`,
  ];
  const benchmarkChild = run(process.execPath, benchmarkArgs, { cwd: repoRoot, stdio: "inherit" });
  let benchmarkReceiptValid = false;
  if (benchmarkChild.status === 0) {
    const benchmarkReceipt = JSON.parse(await readFile(options.benchmark, "utf8"));
    benchmarkReceiptValid = benchmarkReceipt.schemaVersion === 1 &&
      benchmarkReceipt.policyVersion === BENCHMARK_CAMPAIGN_POLICY_VERSION &&
      benchmarkReceipt.candidate?.commit === candidate.commit &&
      benchmarkReceipt.candidate?.tree === candidate.tree &&
      benchmarkReceipt.aggregate?.sampleCount >= MIN_BENCHMARK_SAMPLES &&
      benchmarkReceipt.sourceTreeUnchanged === true &&
      benchmarkReceipt.pass === true;
  }
  receipt.checks.go_benchmark_campaign = {
    pass: benchmarkChild.status === 0 && benchmarkReceiptValid,
    command: `node go/conformance/run-benchmark-campaign.mjs --samples=${MIN_BENCHMARK_SAMPLES}`,
    exitCode: benchmarkChild.status,
    durationMs: Date.now() - benchmarkStarted,
    receipt: options.benchmark,
  };

  const queueTemporary = `${options.queue}.${process.pid}.tmp`;
  process.stdout.write("\n== queue_handoff: isolated Node -> Go -> Node -> Go rehearsal ==\n");
  const queueStarted = Date.now();
  const queueChild = run(process.execPath, [resolve(scriptDir, "run-queue-handoff-rehearsal.mjs")], {
    cwd: goRoot,
    stdio: "inherit",
    env: {
      JANUSLY_HANDOFF_TESTED_TREE: candidate.tree,
      JANUSLY_HANDOFF_EVIDENCE: queueTemporary,
      GOCACHE: process.env.GOCACHE ?? "/private/tmp/janusly-go-build-cache",
    },
  });
  let queueReceiptValid = false;
  if (queueChild.status === 0) {
    const queueReceipt = JSON.parse(await readFile(queueTemporary, "utf8"));
    queueReceiptValid = queueReceipt.schemaVersion === 1 &&
      queueReceipt.testedTree === candidate.tree &&
      queueReceipt.nodeOracleCommit === NODE_ORACLE_COMMIT &&
      queueReceipt.pass === true;
    if (queueReceiptValid) {
      await mkdir(dirname(options.queue), { recursive: true });
      await rename(queueTemporary, options.queue);
    }
  }
  if (!queueReceiptValid) await unlink(queueTemporary).catch(() => undefined);
  receipt.queueHandoff = {
    pass: queueChild.status === 0 && queueReceiptValid,
    exitCode: queueChild.status,
    durationMs: Date.now() - queueStarted,
    receipt: options.queue,
  };

  const finalCommit = git(["rev-parse", "HEAD"]);
  const finalTree = git(["rev-parse", "HEAD^{tree}"]);
  const statusAfter = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  receipt.checks.source_tree_unchanged = {
    pass: finalCommit === candidate.commit && finalTree === candidate.tree && statusAfter === "",
    command: "git identity and cleanliness recheck",
    exitCode: finalCommit === candidate.commit && finalTree === candidate.tree && statusAfter === "" ? 0 : 1,
    durationMs: 0,
  };
  receipt.finishedAt = new Date().toISOString();
  receipt.pass = Object.values(receipt.checks).every(check => check.pass === true) && receipt.queueHandoff.pass;
  await writeAtomic(options.output, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`\nRelease check receipt: ${options.output}\n`);
  process.stdout.write(`Release artifact manifest: ${options.artifact}\n`);
  process.stdout.write(`Queue handoff receipt: ${options.queue}\n`);
  process.stdout.write(`Benchmark campaign receipt: ${options.benchmark}\n`);
  process.stdout.write(`Local release checks: ${receipt.pass ? "PASS" : "FAIL"}\n`);
  if (!receipt.pass) process.exitCode = 2;
}

main().catch(error => {
  console.error(`[release-checks] ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
