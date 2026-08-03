#!/usr/bin/env node

// Probe only the pinned Supabase CLI's config acceptance. It never starts,
// stops, resets, or migrates the real local Supabase project.

import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { classifySupabasePostgres18Probe } from "./supabase-postgres18-policy.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const expectUnsupported = process.argv.slice(2).includes("--expect-unsupported");
for (const arg of process.argv.slice(2)) {
  if (arg !== "--expect-unsupported") throw new Error(`unknown argument: ${arg}`);
}

const temporary = await mkdtemp(resolve(tmpdir(), "janusly-supabase-pg18-"));
try {
  const source = await readFile(resolve(repoRoot, "supabase/config.toml"), "utf8");
  const matches = source.match(/^major_version = 17$/gmu) ?? [];
  if (matches.length !== 1) throw new Error("expected exactly one Supabase PostgreSQL 17 exception");
  const probeConfig = source.replace(/^major_version = 17$/mu, "major_version = 18");
  await mkdir(resolve(temporary, "supabase"), { recursive: true });
  await mkdir(resolve(temporary, "home"), { recursive: true });
  await writeFile(resolve(temporary, "supabase/config.toml"), probeConfig, { mode: 0o600 });

  const executable = resolve(repoRoot, "node_modules/.bin/supabase");
  const environment = {
    ...process.env,
    HOME: resolve(temporary, "home"),
    SUPABASE_TELEMETRY_DISABLED: "true",
  };
  const versionResult = spawnSync(executable, ["--version"], { encoding: "utf8", env: environment });
  if (versionResult.error) throw versionResult.error;
  if (versionResult.status !== 0) throw new Error(`could not read Supabase CLI version: ${versionResult.stderr}`);

  const result = spawnSync(executable, ["services", "--workdir", temporary, "--output", "json"], {
    encoding: "utf8",
    env: environment,
  });
  if (result.error) throw result.error;
  const classification = classifySupabasePostgres18Probe(result);
  const report = {
    schemaVersion: 1,
    cliVersion: versionResult.stdout.trim(),
    configMajor: 18,
    ...classification,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (expectUnsupported && classification.configAccepted) {
    console.error("Supabase now accepts PostgreSQL 18; remove the documented PostgreSQL 17 exception and requalify the Auth lab.");
    process.exitCode = 2;
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
