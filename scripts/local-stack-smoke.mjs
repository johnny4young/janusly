/** End-to-end smoke for the persistent local Docker stack. */

import { spawn } from "node:child_process";
import { getLocalStackSettings } from "./local-env.mjs";

const settings = await getLocalStackSettings();
if (!settings.simulatorEnabled) {
  throw new Error(
    "local smoke commands are simulator-only and will not execute external provider effects; set JANUSLY_LOCAL_INTEGRATION_SIMULATOR=true",
  );
}
const apiUrl = process.env.JANUSLY_LOCAL_API_URL ?? settings.apiUrl;
const simulatorUrl = process.env.JANUSLY_LOCAL_SIMULATOR_URL ?? settings.simulatorUrl;
const orgId = process.env.JANUSLY_LOCAL_ORG_ID ?? settings.orgId;
const failureProvider = process.argv.find((argument) => argument.startsWith("--failure="))?.slice("--failure=".length);
const providers = ["github", "slack", "webhook", "email"];
if (failureProvider && !providers.includes(failureProvider)) {
  throw new Error(`--failure must be one of ${providers.join(", ")}`);
}
const headers = {
  "content-type": "application/json",
  "x-org-id": orgId,
  "x-user-id": "local-smoke",
};

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${url} returned ${response.status}: ${text}`);
  return body;
}

async function pollRun(runId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const snapshot = await request(`${apiUrl}/run?runId=${encodeURIComponent(runId)}`, { headers });
    if (["succeeded", "failed", "cancelled"].includes(snapshot.run.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`run ${runId} did not reach a terminal status`);
}

async function setProviderMode(provider, mode) {
  await request(`${simulatorUrl}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, mode }),
  });
}

function runLocalStack(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/local-stack.mjs", command], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`local stack ${command} exited ${code}`)));
  });
}

await request(`${apiUrl}/health`);
await request(`${simulatorUrl}/health`);
await request(`${simulatorUrl}/requests`, { method: "DELETE" });
if (failureProvider) await setProviderMode(failureProvider, "failure");

try {
const stamp = Date.now();
const workflowId = `local-provider-smoke-${stamp}`;
const endpointKey = `local-provider-smoke-${stamp}`;
const eventId = `local-event-${stamp}`;
const workflow = {
  dslVersion: "1.0",
  templatePolicy: "strict",
  id: workflowId,
  name: `Local provider smoke ${stamp}`,
  nodes: [
    { id: "incoming", type: "webhook_received", config: { endpointKey } },
    {
      id: "issue",
      type: "tool",
      config: {
        tool: "github.create_issue",
        resultPolicy: "require_ok",
        input: { credential: "ops_github", owner: "local", repo: "incidents", title: "Local smoke incident" },
      },
    },
    {
      id: "page",
      type: "tool",
      config: { tool: "slack.post", resultPolicy: "require_ok", input: { credential: "ops_slack", text: "Local smoke page" } },
    },
    {
      id: "billing",
      type: "tool",
      config: {
        tool: "webhook.send",
        resultPolicy: "require_ok",
        input: {
          credential: "billing_webhook",
          url: "https://billing.example.com/charges/retry",
          payload: { invoiceId: "local-invoice", eventId: "{{context.incoming.output.event.eventId}}" },
        },
      },
    },
    {
      id: "email",
      type: "tool",
      config: {
        tool: "email.send",
        resultPolicy: "require_ok",
        input: { to: "customer@example.test", subject: "Local delivery", text: "Provider smoke completed." },
      },
    },
  ],
  edges: [
    { from: "incoming", to: "issue" },
    { from: "issue", to: "page" },
    { from: "page", to: "billing" },
    { from: "billing", to: "email" },
  ],
};

await request(`${apiUrl}/workflows/save`, { method: "POST", headers, body: JSON.stringify(workflow) });
const accepted = await request(`${apiUrl}/triggers/webhook/ingest`, {
  method: "POST",
  headers,
  body: JSON.stringify({ endpointKey, eventId, eventType: "local.smoke", payload: { source: "local-stack" } }),
});
const duplicate = await request(`${apiUrl}/triggers/webhook/ingest`, {
  method: "POST",
  headers,
  body: JSON.stringify({ endpointKey, eventId, eventType: "local.smoke", payload: { source: "local-stack" } }),
});
if (duplicate.duplicate !== true || duplicate.runId !== accepted.runId) {
  throw new Error("inbound event deduplication did not return the original run");
}

  const snapshot = await pollRun(accepted.runId);
  const nodeStatuses = Object.fromEntries(snapshot.nodes.map((node) => [node.nodeId, node.status]));
  const failedNodeByProvider = { github: "issue", slack: "page", webhook: "billing", email: "email" };

  if (failureProvider) {
    const failedNode = failedNodeByProvider[failureProvider];
    if (snapshot.run.status !== "failed" || nodeStatuses[failedNode] !== "failed") {
      throw new Error(`expected ${failureProvider}/${failedNode} to fail closed: ${JSON.stringify(snapshot)}`);
    }
    const dlq = await request(`${apiUrl}/v1/dlq?status=open&search=${encodeURIComponent(accepted.runId)}&limit=10`, { headers });
    const deadLetter = dlq.data?.find((entry) => entry.runId === accepted.runId && entry.nodeId === failedNode);
    if (!deadLetter) throw new Error(`failed run ${accepted.runId} did not create a matching open dead letter`);
    const evidence = await request(`${simulatorUrl}/requests`);
    console.log(JSON.stringify({
      ok: true,
      mode: "failure",
      provider: failureProvider,
      failedNode,
      workflowId,
      runId: accepted.runId,
      deadLetterId: deadLetter.id,
      observedProviders: [...new Set(evidence.requests.map((entry) => entry.provider))].sort(),
    }, null, 2));
  } else {
    if (snapshot.run.status !== "succeeded") {
      throw new Error(`local provider smoke failed: ${JSON.stringify(snapshot)}`);
    }
    for (const nodeId of ["incoming", "issue", "page", "billing", "email"]) {
      if (nodeStatuses[nodeId] !== "succeeded") throw new Error(`${nodeId} ended as ${nodeStatuses[nodeId]}`);
    }

    const evidence = await request(`${simulatorUrl}/requests`);
    const observed = new Set(evidence.requests.map((entry) => entry.provider));
    for (const provider of providers) {
      if (!observed.has(provider)) throw new Error(`provider simulator did not observe ${provider}`);
    }

    if (process.argv.includes("--restart")) {
      await runLocalStack("restart");
      const latest = await request(`${apiUrl}/workflows/latest?workflowId=${encodeURIComponent(workflowId)}`, { headers });
      if (latest.dagJson?.id !== workflowId) throw new Error("workflow did not survive the local stack restart");
      const persistedRun = await request(`${apiUrl}/run?runId=${encodeURIComponent(accepted.runId)}`, { headers });
      if (persistedRun.run.status !== "succeeded") throw new Error("terminal run did not survive the local stack restart");
    }

    console.log(JSON.stringify({
      ok: true,
      mode: "success",
      workflowId,
      runId: accepted.runId,
      eventId,
      duplicate: true,
      providers: [...observed].sort(),
      restartVerified: process.argv.includes("--restart"),
    }, null, 2));
  }
} finally {
  if (failureProvider) await setProviderMode(failureProvider, "success");
}
