#!/usr/bin/env node

// Generate a candidate-bound manifest from Git, immutable source checksums,
// local validation receipts, and external rollout receipts. The manifest does
// not execute gates; run-release-checks.mjs owns local command execution.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NODE_ORACLE_COMMIT } from "./queue-handoff-policy.mjs";
import { evaluateReleaseCandidate } from "./release-candidate-policy.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const goRoot = resolve(scriptDir, "..");
const repoRoot = resolve(goRoot, "..");

const POSTGRES_CONFIGS = Object.freeze([
  "docker-compose.yml",
  "go/docker-compose.yml",
  "go/pg18.compose.yml",
  "go/conformance/benchmark.compose.yml",
  "go/conformance/reference-stack.compose.yml",
]);

const IMAGE_SOURCES = Object.freeze([
  "Dockerfile.api",
  "Dockerfile.prod",
  "Dockerfile.web",
  "deploy/local/Dockerfile.simulator",
  "docker-compose.yml",
  "go/docker-compose.yml",
  "go/pg18.compose.yml",
  "go/conformance/benchmark.compose.yml",
  "go/conformance/reference-stack.compose.yml",
  "deploy/local/compose.yml",
  "deploy/observability/compose.local.yml",
  "deploy/observability/compose.cloud.yml",
]);

const PROVENANCE_FILES = Object.freeze([
  "apps/api/openapi.v1.json",
  "go/contract/openapi.json",
  "pnpm-lock.yaml",
  "go/go.sum",
  "go/AUDIT.md",
  "go/RUNBOOK-CUTOVER.md",
  "go/conformance/benchmark-campaign-policy.mjs",
  "go/conformance/benchmark.compose.yml",
  "go/conformance/perf/campaign-baseline.json",
  "go/conformance/perf/k6-bench-ab.js",
  "go/conformance/run-bench-ab.mjs",
  "go/conformance/run-benchmark-campaign.mjs",
  "deploy/observability/grafana/dashboards/janusly-go-migration.json",
]);

function git(args, { allowFailure = false } = {}) {
  const child = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (child.status === 0) return child.stdout.trim();
  if (allowFailure) return null;
  throw new Error(`git ${args.join(" ")} failed: ${child.stderr || child.stdout}`);
}

function resolveRef(ref) {
  return git(["rev-parse", "--verify", ref], { allowFailure: true });
}

function isAncestor(ancestor, descendant = "HEAD") {
  if (!ancestor) return false;
  const child = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (child.status === 0) return true;
  if (child.status === 1) return false;
  throw new Error(`git merge-base failed: ${child.stderr || child.stdout}`);
}

function countMainUniquePatches(originMain) {
  if (!originMain) return null;
  const output = git(["cherry", "HEAD", "origin/main"], { allowFailure: true });
  if (output === null) return null;
  if (!output) return 0;
  return output.split(/\r?\n/u).filter(line => line.startsWith("+")).length;
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Could not read JSON receipt ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function sha256File(relativePath) {
  const body = await readFile(resolve(repoRoot, relativePath));
  return { path: relativePath, sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length };
}

async function collectRuntime() {
  const postgres = await Promise.all(POSTGRES_CONFIGS.map(async path => ({
    path,
    source: await readFile(resolve(repoRoot, path), "utf8"),
  })));
  const postgresql18Only = postgres.every(({ source }) =>
    /^\s+image:\s+pgvector\/pgvector:pg18\s*$/mu.test(source) &&
    !/^\s+image:\s*\$\{/mu.test(source) &&
    !/pgvector\/pgvector:pg1[4-7]\b/u.test(source));

  const references = new Set();
  for (const path of IMAGE_SOURCES) {
    const source = await readFile(resolve(repoRoot, path), "utf8");
    for (const line of source.split(/\r?\n/u)) {
      const from = line.match(/^FROM\s+([^\s]+)(?:\s+AS\s+\S+)?$/iu)?.[1];
      const image = line.match(/^\s*image:\s+([^\s#]+)\s*$/u)?.[1];
      if (from && from !== "base") references.add(from);
      if (image) references.add(image);
    }
  }
  return { postgresql18Only, postgresConfigs: POSTGRES_CONFIGS, imageReferences: [...references].sort() };
}

function parseArgs(argv) {
  const options = {
    json: null,
    markdown: null,
    checks: resolve(repoRoot, "artifacts/go-release-checks.json"),
    queue: resolve(repoRoot, "artifacts/go-queue-handoff-evidence.json"),
    external: resolve(repoRoot, "artifacts/go-external-gates.json"),
    check: null,
  };
  for (const arg of argv) {
    if (arg.startsWith("--json=")) options.json = resolve(process.cwd(), arg.slice(7));
    else if (arg.startsWith("--markdown=")) options.markdown = resolve(process.cwd(), arg.slice(11));
    else if (arg.startsWith("--checks=")) options.checks = resolve(process.cwd(), arg.slice(9));
    else if (arg.startsWith("--queue=")) options.queue = resolve(process.cwd(), arg.slice(8));
    else if (arg.startsWith("--external=")) options.external = resolve(process.cwd(), arg.slice(11));
    else if (arg === "--check-review") options.check = "review";
    else if (arg === "--check-production") options.check = "production";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function markdown(manifest) {
  const lines = [
    "# Janusly Go release candidate",
    "",
    `- Commit: \`${manifest.candidate.commit}\``,
    `- Tree: \`${manifest.candidate.tree}\``,
    `- Branch: \`${manifest.candidate.branch}\``,
    `- Generated: ${manifest.generatedAt}`,
    `- Ready for review: **${manifest.verdict.readyForReview ? "yes" : "no"}**`,
    `- Ready for production: **${manifest.verdict.readyForProduction ? "yes" : "no"}**`,
    "",
    "## Review blockers",
    "",
  ];
  if (manifest.verdict.reviewBlockers.length === 0) lines.push("- None.");
  else for (const row of manifest.verdict.reviewBlockers) lines.push(`- \`${row.code}\`: ${row.message}`);
  lines.push("", "## External gates", "");
  for (const [gate, status] of Object.entries(manifest.verdict.externalGateStates)) {
    lines.push(`- \`${gate}\`: ${status}`);
  }
  lines.push("", "## Source provenance", "");
  for (const file of manifest.provenance) lines.push(`- \`${file.path}\`: \`${file.sha256}\` (${file.bytes} bytes)`);
  lines.push("", "## Runtime images", "");
  for (const image of manifest.runtime.imageReferences) lines.push(`- \`${image}\``);
  return `${lines.join("\n")}\n`;
}

async function writeAtomic(path, body) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, body, { mode: 0o600 });
  await rename(temporary, path);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const commit = git(["rev-parse", "HEAD"]);
  const tree = git(["rev-parse", "HEAD^{tree}"]);
  const originDevelop = resolveRef("origin/develop");
  const originMain = resolveRef("origin/main");
  const goIntegration = resolveRef("go-integration");
  const nodeOracle = resolveRef("nodejs-legacy");
  const dirtyStatus = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const candidate = {
    commit,
    tree,
    branch: git(["branch", "--show-current"]) || "detached",
    committedAt: git(["show", "-s", "--format=%cI", "HEAD"]),
    dirty: dirtyStatus.length > 0,
    dirtyPaths: dirtyStatus ? dirtyStatus.split(/\r?\n/u) : [],
  };
  const refs = {
    originDevelop,
    originDevelopAncestor: isAncestor(originDevelop),
    aheadOfOriginDevelop: originDevelop ? Number(git(["rev-list", "--count", "origin/develop..HEAD"])) : null,
    originMain,
    originMainUniquePatches: countMainUniquePatches(originMain),
    goIntegration,
    goIntegrationAncestor: isAncestor(goIntegration),
    nodeOracle,
  };
  const [runtime, provenance, checkReceipt, queueHandoffReceipt, externalGateReceipt] = await Promise.all([
    collectRuntime(),
    Promise.all(PROVENANCE_FILES.map(sha256File)),
    readOptionalJson(options.checks),
    readOptionalJson(options.queue),
    readOptionalJson(options.external),
  ]);
  const verdict = evaluateReleaseCandidate({
    candidate,
    refs,
    runtime,
    nodeOracleExpected: NODE_ORACLE_COMMIT,
    checkReceipt,
    queueHandoffReceipt,
    externalGateReceipt,
  });
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    candidate,
    refs,
    nodeOracleExpected: NODE_ORACLE_COMMIT,
    runtime,
    provenance,
    receipts: {
      localChecks: options.checks,
      queueHandoff: options.queue,
      externalGates: options.external,
    },
    verdict,
  };
  const jsonBody = `${JSON.stringify(manifest, null, 2)}\n`;
  if (options.json) await writeAtomic(options.json, jsonBody);
  if (options.markdown) await writeAtomic(options.markdown, markdown(manifest));
  process.stdout.write(jsonBody);
  if (options.check === "review" && !verdict.readyForReview) process.exitCode = 2;
  if (options.check === "production" && !verdict.readyForProduction) process.exitCode = 2;
}

main().catch(error => {
  console.error(`[release-candidate] ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
