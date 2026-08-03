#!/usr/bin/env node

// Run explicit opt-in qualification orchestrators against one clean source
// tree and emit an ignored exact-candidate receipt. Profiles that can reset
// local data require acknowledgement; real-provider use needs a second consent.

import { spawnSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALL_LOCAL_PROFILES,
  assertQualificationRequest,
  QUALIFICATION_PROFILES,
  resolveQualificationProfiles,
} from "./qualification-profiles.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
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

export function parseQualificationArgs(argv, cwd = process.cwd()) {
  const options = {
    profiles: null,
    output: resolve(repoRoot, "artifacts/go-qualification.json"),
    evidence: resolve(repoRoot, "artifacts/qualification"),
    confirmDestructive: false,
    confirmProviderCost: false,
    list: false,
  };
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg.startsWith("--profiles=")) options.profiles = arg.slice(11);
    else if (arg.startsWith("--output=")) options.output = resolve(cwd, arg.slice(9));
    else if (arg.startsWith("--evidence=")) options.evidence = resolve(cwd, arg.slice(11));
    else if (arg === "--confirm-destructive") options.confirmDestructive = true;
    else if (arg === "--confirm-provider-cost") options.confirmProviderCost = true;
    else if (arg === "--list") options.list = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function printCatalog() {
  const rows = Object.entries(QUALIFICATION_PROFILES).map(([id, profile]) => ({
    id,
    description: profile.description,
    destructive: profile.destructive,
    providerCost: profile.providerCost,
    covers: profile.covers,
  }));
  process.stdout.write(`${JSON.stringify({ profiles: rows, allLocal: ALL_LOCAL_PROFILES }, null, 2)}\n`);
}

async function writeAtomic(path, body) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, body, { mode: 0o600 });
  await rename(temporary, path);
}

function commandLabel([command, args]) {
  return [command, ...args].join(" ");
}

async function main() {
  const options = parseQualificationArgs(process.argv.slice(2));
  if (options.list) {
    printCatalog();
    return;
  }
  const profileIds = resolveQualificationProfiles(options.profiles);
  assertQualificationRequest({
    profileIds,
    confirmDestructive: options.confirmDestructive,
    confirmProviderCost: options.confirmProviderCost,
  });
  const statusBefore = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (statusBefore) throw new Error(`qualification requires a clean worktree:\n${statusBefore}`);

  const candidate = {
    commit: git(["rev-parse", "HEAD"]),
    tree: git(["rev-parse", "HEAD^{tree}"]),
  };
  const receipt = {
    schemaVersion: 1,
    candidate,
    startedAt: new Date().toISOString(),
    profiles: {},
  };
  let stop = false;
  for (const id of profileIds) {
    if (stop) break;
    const profile = QUALIFICATION_PROFILES[id];
    const evidenceDir = resolve(options.evidence, id);
    await mkdir(evidenceDir, { recursive: true });
    const profileReceipt = {
      pass: true,
      description: profile.description,
      covers: profile.covers,
      startedAt: new Date().toISOString(),
      steps: [],
      cleanup: [],
      evidenceDirectory: evidenceDir,
    };
    receipt.profiles[id] = profileReceipt;
    for (const step of profile.steps) {
      const started = Date.now();
      process.stdout.write(`\n== ${id}: ${commandLabel(step)} ==\n`);
      const child = run(step[0], step[1], {
        stdio: "inherit",
        env: { JANUSLY_EVIDENCE_DIR: evidenceDir },
      });
      profileReceipt.steps.push({
        command: commandLabel(step),
        pass: child.status === 0,
        exitCode: child.status,
        durationMs: Date.now() - started,
      });
      if (child.status !== 0) {
        profileReceipt.pass = false;
        stop = true;
        break;
      }
    }
    for (const step of profile.cleanup ?? []) {
      const started = Date.now();
      process.stdout.write(`\n== ${id} cleanup: ${commandLabel(step)} ==\n`);
      const child = run(step[0], step[1], { stdio: "inherit" });
      profileReceipt.cleanup.push({
        command: commandLabel(step),
        pass: child.status === 0,
        exitCode: child.status,
        durationMs: Date.now() - started,
      });
      if (child.status !== 0) {
        profileReceipt.pass = false;
        stop = true;
      }
    }
    profileReceipt.finishedAt = new Date().toISOString();
  }

  const finalCommit = git(["rev-parse", "HEAD"]);
  const finalTree = git(["rev-parse", "HEAD^{tree}"]);
  const statusAfter = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  receipt.sourceTreeUnchanged = finalCommit === candidate.commit &&
    finalTree === candidate.tree && statusAfter === "";
  receipt.finishedAt = new Date().toISOString();
  receipt.pass = profileIds.every(id => receipt.profiles[id]?.pass === true) && receipt.sourceTreeUnchanged;
  await writeAtomic(options.output, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`\nQualification receipt: ${options.output}\n`);
  process.stdout.write(`Qualification verdict: ${receipt.pass ? "PASS" : "FAIL"}\n`);
  if (!receipt.pass) process.exitCode = 2;
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  main().catch(error => {
    console.error(`[qualification] ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  });
}
