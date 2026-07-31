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

async function setProviderMode(url, provider, mode) {
  const response = await fetch(`${url}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, mode }),
  });
  assert.equal(response.status, 200);
}

async function completeAnthropic(url) {
  return fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "local-test-key",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{ role: "user", content: "Assess the retry." }],
    }),
  });
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

test("provider simulator applies webhook modes to named endpoint paths", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "janusly-named-webhook-simulator-"));
  const simulator = await startSimulator(dataDir);
  try {
    const endpoint = `${simulator.url}/webhook/provider-qualification-read`;

    const successResponse = await fetch(endpoint, { method: "GET" });
    assert.equal(successResponse.status, 202);
    const success = await successResponse.json();
    assert.equal(success.accepted, true);
    assert.equal(success.receipt.provider, "webhook");

    await setProviderMode(simulator.url, "webhook", "failure");
    const failureResponse = await fetch(endpoint, { method: "GET" });
    assert.equal(failureResponse.status, 503);
    assert.deepEqual(await failureResponse.json(), {
      error: "simulated webhook outage",
    });

    const requests = await (await fetch(`${simulator.url}/requests`)).json();
    assert.equal(
      requests.requests.filter(
        (entry) =>
          entry.provider === "webhook"
          && entry.path === "/webhook/provider-qualification-read",
      ).length,
      2,
    );

    const unrelatedResponse = await fetch(`${simulator.url}/webhooks/not-a-provider`);
    assert.equal(unrelatedResponse.status, 404);
  } finally {
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("provider simulator exposes deterministic Anthropic-compatible semantic outcomes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "janusly-anthropic-simulator-"));
  const simulator = await startSimulator(dataDir);
  try {
    await setProviderMode(
      simulator.url,
      "anthropic",
      "semantic_violation",
    );
    const violationResponse = await completeAnthropic(simulator.url);
    assert.equal(violationResponse.status, 200);
    const violation = await violationResponse.json();
    assert.equal(violation.type, "message");
    assert.equal(violation.role, "assistant");
    assert.equal(violation.stop_reason, "end_turn");
    assert.deepEqual(JSON.parse(violation.content[0].text), {
      decision: "hold",
      riskScore: 0.92,
      reason: "The model could not verify the retry against the business policy.",
    });

    await setProviderMode(simulator.url, "anthropic", "success");
    const successResponse = await completeAnthropic(simulator.url);
    assert.equal(successResponse.status, 200);
    const success = await successResponse.json();
    assert.deepEqual(JSON.parse(success.content[0].text), {
      decision: "retry",
      riskScore: 0.12,
      reason: "The retry is within the configured business policy.",
    });

    const requests = await (await fetch(`${simulator.url}/requests`)).json();
    assert.equal(
      requests.requests.filter((entry) => entry.provider === "anthropic").length,
      2,
    );
  } finally {
    await simulator.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});
