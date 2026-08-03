#!/usr/bin/env node

// Build one native, deployable Go binary with exact source identity, then ask
// the finished binary to hash itself. Generated output stays ignored; this
// command never publishes or deploys the artifact.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateReleaseArtifactManifest } from "./release-artifact-policy.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const goRoot = resolve(scriptDir, "..");
const repoRoot = resolve(goRoot, "..");
const buildCommitVariable = "github.com/johnny4young/janusly/go/internal/buildinfo.buildCommit";
const buildTreeVariable = "github.com/johnny4young/janusly/go/internal/buildinfo.buildTree";

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? goRoot,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
}

function checked(command, args, options = {}) {
  const child = run(command, args, options);
  if (child.status !== 0) {
    const detail = child.error?.message || child.stderr || child.stdout || `exit ${child.status}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return typeof child.stdout === "string" ? child.stdout.trim() : "";
}

function git(args) {
  return checked("git", args, { cwd: repoRoot });
}

function parseArgs(argv, host) {
  const options = {
    goos: host.goos,
    goarch: host.goarch,
    outputDir: null,
  };
  for (const arg of argv) {
    if (arg.startsWith("--goos=")) options.goos = arg.slice(7);
    else if (arg.startsWith("--goarch=")) options.goarch = arg.slice(9);
    else if (arg.startsWith("--output-dir=")) options.outputDir = resolve(process.cwd(), arg.slice(13));
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const [label, value] of [["GOOS", options.goos], ["GOARCH", options.goarch]]) {
    if (!/^[a-z0-9]+$/u.test(value)) throw new Error(`${label} is invalid: ${JSON.stringify(value)}`);
  }
  if (options.goos !== host.goos || options.goarch !== host.goarch) {
    throw new Error(`release artifact must be built natively on ${options.goos}/${options.goarch}; builder is ${host.goos}/${host.goarch}`);
  }
  options.outputDir ??= resolve(repoRoot, `artifacts/go-release/${options.goos}-${options.goarch}`);
  return options;
}

async function writeAtomic(path, body) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, body, { mode: 0o600 });
  await rename(temporary, path);
}

async function main() {
  const [hostGoos, hostGoarch] = checked("go", ["env", "GOHOSTOS", "GOHOSTARCH"]).split(/\r?\n/u);
  const options = parseArgs(process.argv.slice(2), { goos: hostGoos, goarch: hostGoarch });
  const statusBefore = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (statusBefore) throw new Error(`release artifact requires a clean worktree:\n${statusBefore}`);
  const candidate = {
    commit: git(["rev-parse", "HEAD"]),
    tree: git(["rev-parse", "HEAD^{tree}"]),
  };
  const toolchain = checked("go", ["env", "GOVERSION"]);
  await mkdir(options.outputDir, { recursive: true });
  const suffix = options.goos === "windows" ? ".exe" : "";
  const binary = resolve(options.outputDir, `janusly-go${suffix}`);
  const temporaryBinary = `${binary}.${process.pid}.tmp`;
  const manifestPath = resolve(options.outputDir, "manifest.json");
  const ldflags = [
    "-s",
    "-w",
    "-buildid=",
    `-X ${buildCommitVariable}=${candidate.commit}`,
    `-X ${buildTreeVariable}=${candidate.tree}`,
  ].join(" ");
  try {
    checked("go", [
      "build",
      "-trimpath",
      "-buildvcs=false",
      "-ldflags", ldflags,
      "-o", temporaryBinary,
      "./cmd/api",
    ], {
      env: { GOOS: options.goos, GOARCH: options.goarch, CGO_ENABLED: "0" },
      stdio: "inherit",
    });
    await chmod(temporaryBinary, 0o755);
    const body = await readFile(temporaryBinary);
    const artifactSha256 = createHash("sha256").update(body).digest("hex");
    const artifactStat = await stat(temporaryBinary);
    const proof = JSON.parse(checked(temporaryBinary, ["provenance"]));
    await rm(binary, { force: true });
    await rename(temporaryBinary, binary);

    const finalCommit = git(["rev-parse", "HEAD"]);
    const finalTree = git(["rev-parse", "HEAD^{tree}"]);
    const statusAfter = git(["status", "--porcelain=v1", "--untracked-files=all"]);
    const sourceTreeUnchanged = finalCommit === candidate.commit && finalTree === candidate.tree && statusAfter === "";
    const manifest = {
      schemaVersion: 1,
      candidate,
      target: { goos: options.goos, goarch: options.goarch, cgoEnabled: false },
      toolchain,
      build: { trimpath: true, buildVcs: false, buildId: "" },
      artifact: { file: basename(binary), sha256: artifactSha256, bytes: artifactStat.size },
      runtimeIdentity: proof,
      sourceTreeUnchanged,
      pass: sourceTreeUnchanged && proof?.verified === true && proof?.artifactSha256 === artifactSha256,
    };
    validateReleaseArtifactManifest(manifest, candidate);
    await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ manifest: manifestPath, ...manifest }, null, 2)}\n`);
  } finally {
    await rm(temporaryBinary, { force: true });
  }
}

main().catch(error => {
  console.error(`[release-artifact] ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
