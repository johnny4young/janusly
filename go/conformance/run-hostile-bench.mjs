// Hostile-world bench wrapper (T-535): boots the Go binary against the
// pilot DB, runs conformance/perf/k6-hostile.js (baseline reads → chaos
// writes + hostile reads), and enforces the bounded-degradation
// contract: hostile p95 must stay under 2× the healthy baseline p95 for
// every read family (runs list, dlq list, health). The verdict appends
// to BENCH.md + hostile-series.jsonl so future regressions are visible.
//
//   node go/conformance/run-hostile-bench.mjs
//
// Never run with the 24h soak unfrozen on the same host (SIGSTOP it
// first — the co-residency rule); requires the pilot DB up.

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GO_DIR = join(HERE, "..");
const PERF = join(HERE, "perf");
const DB = process.env.JANUSLY_GO_DATABASE_URL
  ?? "postgres://janusly:janusly-go-local@127.0.0.1:4632/janusly_go";
const RUN_ID = Date.now().toString(36);
const RATIO_LIMIT = 2.0;

console.error("== hostile bench: build + boot ==");
execFileSync("go", ["build", "-o", "/tmp/janusly-go-hostile-api", "./cmd/api"], { cwd: GO_DIR, stdio: "inherit" });
const api = spawn("/tmp/janusly-go-hostile-api", [], {
  env: {
    ...process.env,
    JANUSLY_GO_DATABASE_URL: DB,
    JANUSLY_GO_WORK_PLANE_ENABLED: "true",
    JANUSLY_GO_PORT: "4610",
    JANUSLY_GO_INTERNAL_PORT: "4611",
    JANUSLY_GO_POLL_MS: "50",
    OTEL_EXPORTER: "none",
  },
  stdio: ["ignore", "ignore", "inherit"],
});
process.on("exit", () => { try { api.kill("SIGTERM"); } catch { /* gone */ } });
for (let i = 0; ; i++) {
  try {
    if ((await fetch("http://127.0.0.1:4610/healthz")).ok) break;
  } catch { /* booting */ }
  if (i > 60) throw new Error("api never became healthy");
  await delay(300);
}

console.error("== hostile bench: k6 (baseline → chaos → hostile) ==");
const summaryPath = join(PERF, "k6-hostile-last.json");
execFileSync("k6", ["run", "--quiet", "--summary-export", summaryPath, "go/conformance/perf/k6-hostile.js"], {
  cwd: join(GO_DIR, ".."),
  env: { ...process.env, BENCH_BASE: "http://127.0.0.1:4610", BENCH_RUN_ID: RUN_ID },
  stdio: "inherit",
});

const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const p95 = (metric) => summary.metrics[metric]?.["p(95)"] ?? null;
const families = [
  { name: "runs list", baseline: p95("baseline_runs_ms"), hostile: p95("hostile_runs_ms") },
  { name: "dlq list", baseline: p95("baseline_dlq_ms"), hostile: p95("hostile_dlq_ms") },
  { name: "health", baseline: p95("baseline_health_ms"), hostile: p95("hostile_health_ms") },
];
const chaosCount = summary.metrics.chaos_starts?.count ?? 0;
if (chaosCount < 20) throw new Error(`chaos generator too quiet (${chaosCount} starts) — the hostile phase proved nothing`);

let failed = false;
const rows = families.map(({ name, baseline, hostile }) => {
  if (baseline === null || hostile === null) {
    failed = true;
    return { name, baseline, hostile, ratio: null, verdict: "missing metric" };
  }
  const ratio = hostile / Math.max(baseline, 0.001);
  const verdict = ratio <= RATIO_LIMIT ? "✅ acotado" : "❌ degradado";
  if (ratio > RATIO_LIMIT) failed = true;
  return { name, baseline, hostile, ratio, verdict };
});

const seriesPath = join(PERF, "hostile-series.jsonl");
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: GO_DIR, encoding: "utf8" }).trim();
appendFileSync(seriesPath, JSON.stringify({ at: new Date().toISOString(), commit, chaosStarts: chaosCount, rows }) + "\n");

const benchPath = join(PERF, "BENCH.md");
const stamp = new Date().toISOString();
const table = rows.map((r) =>
  `| ${r.name} | ${r.baseline?.toFixed(1) ?? "?"} ms | ${r.hostile?.toFixed(1) ?? "?"} ms | ${r.ratio ? r.ratio.toFixed(2) + "×" : "?"} | ${r.verdict} |`
).join("\n");
const section = `\n## Escenario hostil (T-535) — ${stamp} @ \`${commit}\`\n\nLecturas bajo caos (DLQ creciendo + breaker disparando, ${chaosCount} starts fallidos):\np95 hostil debe quedar bajo ${RATIO_LIMIT}× el baseline sano.\n\n| Lectura | p95 sano | p95 hostil | ratio | veredicto |\n|---|---|---|---|---|\n${table}\n\nSerie: \`hostile-series.jsonl\`.\n`;
appendFileSync(benchPath, section);

console.log("\n== hostile bench ==");
for (const r of rows) {
  console.log(`   ${r.name}: ${r.baseline?.toFixed(1)}ms → ${r.hostile?.toFixed(1)}ms (${r.ratio?.toFixed(2)}×) ${r.verdict}`);
}
if (failed) {
  console.error("== hostile bench RED: a read family degraded past 2× ==");
  process.exit(1);
}
console.log(`== hostile bench green (${chaosCount} chaos starts absorbed) ==`);
process.exit(0);
