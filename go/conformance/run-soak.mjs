// make soak — the sustained-load stability harness:
//
//   1. builds and boots the Go binary against the dev database,
//   2. runs conformance/perf/k6-soak.js at a steady mixed load for
//      SOAK_DURATION (default 1h),
//   3. samples go_goroutines + process_resident_memory_bytes + pgx pool
//      gauges from the internal /metrics every SOAK_SAMPLE_SECONDS
//      (default 30) into conformance/perf/soak-<runId>.jsonl,
//   4. writes conformance/perf/SOAK.md — the direction-annotated verdict:
//      first-quarter vs last-quarter averages for RSS and goroutines,
//      with "estable" or "creció" per signal (>10% growth = grew).
//
// Un soak corto para validar el arnés: SOAK_DURATION=3m make soak.

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GO_DIR = join(HERE, "..");
const REPO = join(GO_DIR, "..");
const PERF = join(HERE, "perf");
const API = "http://127.0.0.1:4600";
const INTERNAL = "http://127.0.0.1:4601";
const DB = process.env.JANUSLY_GO_DATABASE_URL
  ?? "postgres://janusly:janusly-go-local@127.0.0.1:4632/janusly_go";
const DURATION = process.env.SOAK_DURATION ?? "1h";
const SAMPLE_SECONDS = Number(process.env.SOAK_SAMPLE_SECONDS ?? 30);

console.error(`== soak: build (duration ${DURATION}, sample every ${SAMPLE_SECONDS}s) ==`);
execFileSync("go", ["build", "-o", "/tmp/janusly-go-soak-api", "./cmd/api"], { cwd: GO_DIR, stdio: "inherit" });

console.error("== soak: boot api ==");
const api = spawn("/tmp/janusly-go-soak-api", [], {
  env: {
    ...process.env,
    JANUSLY_GO_DATABASE_URL: DB,
    JANUSLY_GO_PORT: "4600",
    JANUSLY_GO_INTERNAL_PORT: "4601",
    JANUSLY_GO_POLL_MS: "50",
  },
  stdio: ["ignore", "ignore", "inherit"],
});
const stopApi = () => { try { api.kill("SIGTERM"); } catch { /* gone */ } };
process.on("exit", stopApi);

for (let i = 0; ; i++) {
  try {
    const res = await fetch(`${API}/healthz`);
    if (res.ok) break;
  } catch { /* booting */ }
  if (i > 50) { stopApi(); throw new Error("api never became healthy"); }
  await delay(200);
}

const runId = Date.now().toString(36);
const samplesPath = join(PERF, `soak-${runId}.jsonl`);
const samples = [];
let sampling = true;

async function sampleOnce() {
  try {
    const res = await fetch(`${INTERNAL}/metrics`);
    const text = await res.text();
    const read = (name) => {
      const line = text.split("\n").find((l) => l.startsWith(name + " ") || l.startsWith(name + "{"));
      if (!line) return null;
      const value = Number(line.trim().split(/\s+/).at(-1));
      return Number.isFinite(value) ? value : null;
    };
    const sample = {
      at: new Date().toISOString(),
      rssBytes: read("process_resident_memory_bytes"),
      goroutines: read("go_goroutines"),
      heapInuse: read("go_memstats_heap_inuse_bytes"),
    };
    samples.push(sample);
    appendFileSync(samplesPath, JSON.stringify(sample) + "\n");
  } catch (err) {
    console.error("sample failed:", err.message);
  }
}

const sampler = (async () => {
  while (sampling) {
    await sampleOnce();
    await delay(SAMPLE_SECONDS * 1000);
  }
})();

console.error("== soak: k6 ==");
// k6 must run ASYNC — execFileSync would block the event loop and starve
// the sampler for the whole soak.
let k6Failed = false;
const k6 = spawn("k6", ["run", "--quiet", "go/conformance/perf/k6-soak.js"], {
  cwd: REPO,
  stdio: "inherit",
  env: { ...process.env, SOAK_BASE: API, SOAK_RUN_ID: runId, SOAK_DURATION: DURATION },
});
const k6Code = await new Promise((resolve) => k6.on("close", resolve));
k6Failed = k6Code !== 0;
sampling = false;
await sampler;
await sampleOnce();
stopApi();

// Verdict: first-quarter vs last-quarter averages. >10% growth = grew.
function quarterAverages(key) {
  const values = samples.map((s) => s[key]).filter((v) => typeof v === "number");
  if (values.length < 4) return null;
  const quarter = Math.max(1, Math.floor(values.length / 4));
  const avg = (slice) => slice.reduce((a, b) => a + b, 0) / slice.length;
  return { first: avg(values.slice(0, quarter)), last: avg(values.slice(-quarter)) };
}

const signals = [
  { key: "rssBytes", label: "RSS", unit: (v) => `${(v / 1024 / 1024).toFixed(1)} MB` },
  { key: "goroutines", label: "Goroutines", unit: (v) => v.toFixed(0) },
  { key: "heapInuse", label: "Heap in use", unit: (v) => `${(v / 1024 / 1024).toFixed(1)} MB` },
];

let verdictLines = [];
let grewAny = false;
for (const signal of signals) {
  const quarters = quarterAverages(signal.key);
  if (!quarters) {
    verdictLines.push(`| ${signal.label} | — | — | — | sin muestras suficientes |`);
    continue;
  }
  const growth = quarters.first > 0 ? (quarters.last - quarters.first) / quarters.first : 0;
  const grew = growth > 0.1;
  grewAny = grewAny || grew;
  const arrow = grew ? "▲ creció" : (growth < -0.05 ? "▼ bajó" : "◆ estable");
  verdictLines.push(`| ${signal.label} | ${signal.unit(quarters.first)} | ${signal.unit(quarters.last)} | ${(growth * 100).toFixed(1)}% | ${arrow} |`);
}

const report = `# Soak — última corrida

- runId: ${runId}
- duración: ${DURATION} (muestras cada ${SAMPLE_SECONDS}s, ${samples.length} muestras)
- k6: ${k6Failed ? "FALLÓ" : "ok"}
- veredicto: **${grewAny ? "CRECIÓ — investigar antes de promover" : "ESTABLE"}**

Comparación primer cuarto vs último cuarto de la corrida (una carga
sostenida con crecimiento >10% entre extremos señala fuga; el arranque
caliente queda absorbido por el promedio del primer cuarto).

| Señal | Primer cuarto | Último cuarto | Δ | Dirección |
| --- | --- | --- | --- | --- |
${verdictLines.join("\n")}

Serie completa: \`soak-${runId}.jsonl\`.
`;
writeFileSync(join(PERF, "SOAK.md"), report);
console.error(report);
if (k6Failed || grewAny) process.exit(1);
