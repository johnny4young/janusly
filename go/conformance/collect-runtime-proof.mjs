#!/usr/bin/env node

// Collect one runtime proof snapshot without mutating traffic or deployment.
// The internal listener supplies executable identity + metric; the public
// liveness response supplies the ownership header seen by real callers.

import { spawnSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateRuntimeProof } from "./runtime-proof-policy.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const goRoot = resolve(scriptDir, "..");
const repoRoot = resolve(goRoot, "..");
const smallResponseLimit = 64 * 1024;
const metricsResponseLimit = 8 * 1024 * 1024;

function git(args) {
  const child = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  if (child.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${child.stderr || child.stdout}`);
  return child.stdout.trim();
}

export function normalizeOrigin(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) origin`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    !url.hostname || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error(`${label} must be an absolute HTTP(S) origin without credentials, path, query, or fragment`);
  }
  return url.origin;
}

export function parseWorkPlaneMetric(source) {
  const values = [];
  for (const line of source.split(/\r?\n/u)) {
    const match = line.match(/^janusly_go_work_plane_active(?:\{[^}]*\})?\s+([01](?:\.0+)?)$/u);
    if (match) values.push(Number(match[1]));
  }
  if (values.length !== 1) {
    throw new Error(`expected exactly one janusly_go_work_plane_active sample, found ${values.length}`);
  }
  return values[0];
}

function parseArgs(argv) {
  const options = { publicOrigin: null, internalOrigin: null, mode: null, output: null };
  for (const arg of argv) {
    if (arg.startsWith("--public-origin=")) options.publicOrigin = normalizeOrigin(arg.slice(16), "public origin");
    else if (arg.startsWith("--internal-origin=")) options.internalOrigin = normalizeOrigin(arg.slice(18), "internal origin");
    else if (arg.startsWith("--mode=")) options.mode = arg.slice(7);
    else if (arg.startsWith("--output=")) options.output = resolve(process.cwd(), arg.slice(9));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.publicOrigin || !options.internalOrigin) {
    throw new Error("--public-origin and --internal-origin are required");
  }
  if (!["active", "passive"].includes(options.mode)) {
    throw new Error("--mode must be active or passive");
  }
  return options;
}

export async function readBoundedText(response, url, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`${url} response exceeds ${maxBytes} bytes`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${url} returned no response body`);
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`${url} response exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function fetchText(url, maxBytes) {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    headers: { accept: "text/plain, application/json" },
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return { response, body: await readBoundedText(response, url, maxBytes) };
}

async function writeAtomic(path, body) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, body, { mode: 0o600 });
  await rename(temporary, path);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) throw new Error(`runtime proof requires a clean exact-candidate checkout:\n${status}`);
  const candidate = {
    commit: git(["rev-parse", "HEAD"]),
    tree: git(["rev-parse", "HEAD^{tree}"]),
  };
  const [{ body: buildBody }, { response: health }, { body: metrics }] = await Promise.all([
    fetchText(`${options.internalOrigin}/build`, smallResponseLimit),
    fetchText(`${options.publicOrigin}/healthz`, smallResponseLimit),
    fetchText(`${options.internalOrigin}/metrics`, metricsResponseLimit),
  ]);
  const proof = {
    schemaVersion: 1,
    candidate,
    capturedAt: new Date().toISOString(),
    runtime: JSON.parse(buildBody),
    workPlane: {
      header: health.headers.get("x-janusly-work-plane"),
      metric: parseWorkPlaneMetric(metrics),
    },
  };
  validateRuntimeProof(proof, candidate, options.mode);
  const body = `${JSON.stringify(proof, null, 2)}\n`;
  if (options.output) await writeAtomic(options.output, body);
  process.stdout.write(body);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[runtime-proof] ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  });
}
