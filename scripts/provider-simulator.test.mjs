import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

async function startSimulator(dataDir) {
  const child = spawn(process.execPath, ["deploy/local/provider-simulator.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0", SIMULATOR_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`simulator start timed out: ${stderr}`)), 10_000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(`http://127.0.0.1:${match[1]}`);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`simulator exited before ready with code ${code}: ${stderr}`));
    });
  });
  return {
    child,
    url,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

async function deliver(url, scope) {
  const response = await fetch(`${url}/webhook?target=https%3A%2F%2Fbilling.example.com%2Fcharges%2Fretry`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-idempotency-key": "invoice-1",
      ...(scope === "validation" ? { "x-janusly-simulation-scope": "validation" } : {}),
    },
    body: JSON.stringify({ invoiceId: "invoice-1" }),
  });
  assert.equal(response.status, 202);
  return (await response.json()).receipt;
}

test("provider simulator persists idempotent effects and isolates validation scope", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "janusly-provider-simulator-"));
  let simulator = await startSimulator(dataDir);
  try {
    const firstValidation = await deliver(simulator.url, "validation");
    const duplicateValidation = await deliver(simulator.url, "validation");
    const firstProduction = await deliver(simulator.url, "production");

    assert.deepEqual(
      { applied: firstValidation.applied, duplicate: firstValidation.duplicate },
      { applied: true, duplicate: false },
    );
    assert.deepEqual(
      { applied: duplicateValidation.applied, duplicate: duplicateValidation.duplicate },
      { applied: false, duplicate: true },
    );
    assert.equal(duplicateValidation.effectId, firstValidation.effectId);
    assert.equal(firstProduction.scope, "production");
    assert.equal(firstProduction.applied, true);
    assert.notEqual(firstProduction.effectId, firstValidation.effectId);

    const beforeRestart = await (await fetch(`${simulator.url}/effects`)).json();
    assert.equal(beforeRestart.effects.length, 2);

    await simulator.stop();
    simulator = await startSimulator(dataDir);
    const persistedDuplicate = await deliver(simulator.url, "validation");
    assert.equal(persistedDuplicate.duplicate, true);
    assert.equal(persistedDuplicate.effectId, firstValidation.effectId);
  } finally {
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});
