#!/usr/bin/env node

// Validate one external gate evidence document and atomically merge its
// bounded, hashed summary into the exact-candidate aggregate receipt. This
// command records facts; it never invokes GitHub, a proxy, or a deployment.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXTERNAL_GATE_POLICY_VERSION,
  externalGateTemplate,
  validateExternalGateEvidence,
} from "./external-gate-policy.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const goRoot = resolve(scriptDir, "..");
const repoRoot = resolve(goRoot, "..");

function runGit(args) {
  const child = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (child.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${child.stderr || child.stdout}`);
  return child.stdout.trim();
}

function parseArgs(argv) {
  const options = {
    gate: null,
    input: null,
    output: resolve(repoRoot, "artifacts/go-external-gates.json"),
    template: null,
    replaceStale: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--gate=")) options.gate = arg.slice(7);
    else if (arg.startsWith("--input=")) options.input = resolve(process.cwd(), arg.slice(8));
    else if (arg.startsWith("--output=")) options.output = resolve(process.cwd(), arg.slice(9));
    else if (arg.startsWith("--template=")) options.template = arg.slice(11);
    else if (arg === "--replace-stale") options.replaceStale = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(path, body) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, body, { mode: 0o600 });
  await rename(temporary, path);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const candidate = {
    commit: runGit(["rev-parse", "HEAD"]),
    tree: runGit(["rev-parse", "HEAD^{tree}"]),
  };
  if (options.template) {
    process.stdout.write(`${JSON.stringify(externalGateTemplate(options.template, candidate), null, 2)}\n`);
    return;
  }
  if (!options.gate || !options.input) throw new Error("--gate and --input are required");
  const status = runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) throw new Error(`external gate recording requires a clean worktree:\n${status}`);

  const raw = await readFile(options.input);
  const evidence = JSON.parse(raw.toString("utf8"));
  const summary = validateExternalGateEvidence(options.gate, evidence, candidate);
  let aggregate = await readOptionalJson(options.output);
  const stale = aggregate && (
    aggregate.schemaVersion !== 2 ||
    aggregate.policyVersion !== EXTERNAL_GATE_POLICY_VERSION ||
    aggregate.candidate?.commit !== candidate.commit ||
    aggregate.candidate?.tree !== candidate.tree
  );
  if (stale && !options.replaceStale) {
    throw new Error("existing external gate receipt belongs to another candidate or policy; archive it or repeat with --replace-stale");
  }
  if (!aggregate || stale) {
    aggregate = {
      schemaVersion: 2,
      policyVersion: EXTERNAL_GATE_POLICY_VERSION,
      candidate,
      gates: {},
    };
  }
  aggregate.gates[options.gate] = {
    status: "pass",
    validatedAt: new Date().toISOString(),
    evidenceSha256: createHash("sha256").update(raw).digest("hex"),
    evidenceFile: basename(options.input),
    summary,
  };
  aggregate.updatedAt = new Date().toISOString();
  await writeAtomic(options.output, `${JSON.stringify(aggregate, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(aggregate, null, 2)}\n`);
}

main().catch(error => {
  console.error(`[external-gate] ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
