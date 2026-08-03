// make bench — the k6 regression harness:
//
//   1. builds and boots the Go binary against the dev database (make db-up
//      + make migrate first),
//   2. runs conformance/perf/k6-bench.js (three sequential scenarios),
//   3. appends one row to conformance/perf/series.jsonl (the time series),
//   4. regenerates conformance/perf/BENCH.md — a direction-annotated table
//      comparing the latest run against the previous one.
//
// cmd/loadgen remains the CROSS-BACKEND comparison tool (it can drive the
// Node reference too); k6 owns single-backend regression over time.

import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { replaceHealthyReport } from "./perf-report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GO_DIR = join(HERE, "..");
const REPO = join(GO_DIR, "..");
const PERF = join(HERE, "perf");
const API_PORT = Number(process.env.BENCH_API_PORT ?? "4600");
const INTERNAL_PORT = Number(process.env.BENCH_INTERNAL_PORT ?? "4601");
if (![API_PORT, INTERNAL_PORT].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535) || API_PORT === INTERNAL_PORT) {
  throw new Error("BENCH_API_PORT and BENCH_INTERNAL_PORT must be distinct integers in [1024, 65535]");
}
const API = `http://127.0.0.1:${API_PORT}`;
const DB = process.env.JANUSLY_GO_DATABASE_URL
  ?? "postgres://janusly:janusly-go-local@127.0.0.1:4632/janusly_go";
const SUMMARY_INPUT = process.env.BENCH_SUMMARY_PATH ?? "go/conformance/perf/k6-last.json";
const SUMMARY_PATH = isAbsolute(SUMMARY_INPUT) ? SUMMARY_INPUT : resolve(REPO, SUMMARY_INPUT);
const RECORD_HISTORY = process.env.BENCH_RECORD_HISTORY !== "false";
const BINARY = process.env.BENCH_BINARY_PATH ?? `/tmp/janusly-go-bench-api-${process.pid}`;

// direction: "up" = higher is better, "down" = lower is better.
const METRICS = [
  { key: "start.ratePerSec", label: "start: runs terminados/s", direction: "up", unit: "runs/s" },
  { key: "start.p50", label: "start: latencia p50", direction: "down", unit: "ms" },
  { key: "start.p95", label: "start: latencia p95", direction: "down", unit: "ms" },
  { key: "start.p99", label: "start: latencia p99", direction: "down", unit: "ms" },
  { key: "list.ratePerSec", label: "list: lecturas/s", direction: "up", unit: "req/s" },
  { key: "list.p95", label: "list: latencia p95", direction: "down", unit: "ms" },
  { key: "diamond.ratePerSec", label: "diamond: DAGs terminados/s", direction: "up", unit: "runs/s" },
  { key: "diamond.p95", label: "diamond: latencia p95", direction: "down", unit: "ms" },
  { key: "errors", label: "errores (todas las fases)", direction: "down", unit: "" },
];
const pick = (obj, path) => path.split(".").reduce((acc, part) => acc?.[part], obj);
const fmt = (value, unit) => value == null ? "—"
  : `${Number(value).toFixed(value >= 100 ? 0 : 1)}${unit ? " " + unit : ""}`;

console.error("== bench: build ==");
execFileSync("go", ["build", "-o", BINARY, "./cmd/api"], { cwd: GO_DIR, stdio: "inherit" });

console.error("== bench: boot api ==");
const api = spawn(BINARY, [], {
  env: {
    ...process.env,
    JANUSLY_GO_DATABASE_URL: DB,
    JANUSLY_GO_WORK_PLANE_ENABLED: "true",
    JANUSLY_GO_PORT: String(API_PORT),
    JANUSLY_GO_INTERNAL_PORT: String(INTERNAL_PORT),
    JANUSLY_GO_POLL_MS: "50",
    OTEL_EXPORTER: "none",
  },
  stdio: ["ignore", "ignore", "inherit"],
});
const removeBinary = () => { try { unlinkSync(BINARY); } catch { /* task-owned scratch already gone */ } };
const stopApiOnExit = () => { try { api.kill("SIGTERM"); } catch { /* gone */ } };
process.on("exit", () => {
  stopApiOnExit();
  removeBinary();
});
async function stopApi() {
  if (api.exitCode !== null || api.signalCode !== null) return;
  const exited = once(api, "exit");
  try { api.kill("SIGTERM"); } catch { return; }
  await Promise.race([exited, delay(5_000)]);
  if (api.exitCode === null && api.signalCode === null) {
    const killed = once(api, "exit");
    try { api.kill("SIGKILL"); } catch { return; }
    await killed;
  }
}

for (let i = 0; ; i++) {
  try {
    const res = await fetch(`${API}/healthz`);
    if (res.ok) break;
  } catch { /* booting */ }
  if (i > 50) { await stopApi(); throw new Error("api never became healthy"); }
  await delay(200);
}

console.error("== bench: k6 ==");
const runId = Date.now().toString(36);
try {
  execFileSync("k6", ["run", "--quiet", "go/conformance/perf/k6-bench.js"], {
    cwd: REPO,
    stdio: "inherit",
    env: { ...process.env, BENCH_BASE: API, BENCH_RUN_ID: runId, BENCH_SUMMARY_PATH: SUMMARY_INPUT },
  });
} finally {
  await stopApi();
}

const summary = JSON.parse(readFileSync(SUMMARY_PATH, "utf8"));
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: GO_DIR }).toString().trim();
const row = { at: new Date().toISOString(), commit, tool: "k6", ...summary };
if (!RECORD_HISTORY) {
  console.log(JSON.stringify(row));
} else {
  appendFileSync(join(PERF, "series.jsonl"), JSON.stringify(row) + "\n");

  // ---- regenerate the direction-annotated table ---------------------------
  const series = readFileSync(join(PERF, "series.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const latest = series[series.length - 1];
  const previous = series.length > 1 ? series[series.length - 2] : null;

  const lines = [
    "# Bench de regresión (k6)",
    "",
    "Corridas secuenciales de 20s por escenario contra el binario Go en la",
    "máquina local (`make bench`). La serie completa vive en `series.jsonl`;",
    "cada fila compara la última corrida contra la anterior.",
    "",
    "**Cómo leer la tabla:** la columna *Dirección* dice qué significa un",
    "número más grande — `↑ mejor` (rendimiento: más es mejor) o `↓ mejor`",
    "(latencia y errores: menos es mejor). *Δ* es el cambio relativo frente a",
    "la corrida anterior; *Veredicto* ya aplica la dirección por ti.",
    "",
    "**Ruido esperado:** cada corrida agranda la base de datos (~10k filas de",
    "runs/nodos), así que corridas consecutivas no son idénticas; deltas de",
    "hasta ±20% en rendimiento pueden ser ruido de crecimiento o térmico.",
    "Una regresión real se confirma con dos corridas seguidas en la misma",
    "dirección o un cambio de más del 25%.",
    "",
    `Última corrida: ${latest.at} @ \`${latest.commit}\`` +
      (previous ? ` · anterior: ${previous.at} @ \`${previous.commit}\`` : " · (primera corrida — sin comparación)"),
    "",
    "| Métrica | Dirección | Última | Anterior | Δ | Veredicto |",
    "|---|---|---|---|---|---|",
  ];

  for (const metric of METRICS) {
    const now = pick(latest, metric.key);
    const before = previous ? pick(previous, metric.key) : null;
    let delta = "—", verdict = "—";
    if (now != null && before != null && before !== 0) {
      const pct = ((now - before) / before) * 100;
      delta = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
      const improved = metric.direction === "up" ? pct >= 0 : pct <= 0;
      const magnitude = Math.abs(pct);
      verdict = magnitude < 5 ? "≈ igual" : improved ? "✅ mejora" : "⚠️ regresión";
    }
    const arrow = metric.direction === "up" ? "↑ mejor" : "↓ mejor";
    lines.push(`| ${metric.label} | ${arrow} | ${fmt(now, metric.unit)} | ${fmt(before, metric.unit)} | ${delta} | ${verdict} |`);
  }

  lines.push("", `Historial: ${series.length} corrida(s) en \`series.jsonl\`.`, "");
  const benchPath = join(PERF, "BENCH.md");
  const existingReport = existsSync(benchPath) ? readFileSync(benchPath, "utf8") : "";
  writeFileSync(benchPath, replaceHealthyReport(existingReport, lines.join("\n")));
  console.error("== bench: BENCH.md updated ==");
}
removeBinary();
