/**
 * End-to-end PagerDuty workflow smoke for the persistent local simulator.
 *
 * This command explicitly creates managed credentials, generates the workflow
 * from a prompt, saves it, signs one provider event, and verifies the durable
 * run plus external acknowledge/snooze effects. Normal startup stays empty.
 */

import { createHmac, randomBytes } from "node:crypto";

import { getLocalStackSettings } from "./local-env.mjs";

const settings = await getLocalStackSettings();
if (!settings.simulatorEnabled) {
  throw new Error(
    "local PagerDuty smoke is simulator-only; set JANUSLY_LOCAL_INTEGRATION_SIMULATOR=true",
  );
}

const apiUrl = process.env.JANUSLY_LOCAL_API_URL ?? settings.apiUrl;
const simulatorUrl = process.env.JANUSLY_LOCAL_SIMULATOR_URL ?? settings.simulatorUrl;
const orgId = process.env.JANUSLY_LOCAL_ORG_ID ?? settings.orgId;
const headers = {
  "content-type": "application/json",
  "x-org-id": orgId,
  "x-user-id": "local-pagerduty-smoke",
};

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${url} returned ${response.status}: ${text}`);
  }
  return body;
}

async function pollRun(runId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const snapshot = await request(
      `${apiUrl}/run?runId=${encodeURIComponent(runId)}`,
      { headers },
    );
    if (["succeeded", "failed", "cancelled"].includes(snapshot.run.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`PagerDuty run ${runId} did not reach a terminal status`);
}

await request(`${apiUrl}/health`);
await request(`${simulatorUrl}/health`);
await request(`${simulatorUrl}/control`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ provider: "pagerduty", mode: "success" }),
});
await request(`${simulatorUrl}/requests`, { method: "DELETE" });

const stamp = `${Date.now()}-${randomBytes(4).toString("hex")}`;
const apiCredentialName = `pd-api-${stamp}`;
const webhookCredentialName = `pd-webhook-${stamp}`;
const webhookSecret = randomBytes(32).toString("base64url");
const incidentId = `PLOCAL${stamp.replaceAll("-", "").slice(-20)}`;
const eventId = `local-pagerduty-${stamp}`;

await request(`${apiUrl}/credentials`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    name: apiCredentialName,
    kind: "pagerduty_api_token",
    secretValue: `local-api-token-${stamp}`,
  }),
});
await request(`${apiUrl}/credentials`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    name: webhookCredentialName,
    kind: "pagerduty_webhook_secret",
    secretValue: webhookSecret,
  }),
});

// Select a one-hour working window at least two hours ahead in UTC. Both the
// event timestamp and immediate receipt are therefore outside working hours,
// regardless of when the smoke is executed.
const now = new Date();
const workingStartHour = (now.getUTCHours() + 2) % 24;
const workingEndHour = (workingStartHour + 1) % 24;
const clock = (hour) => `${String(hour).padStart(2, "0")}:00`;
const prompt = [
  "Create a PagerDuty off-hours workflow.",
  `For PagerDuty user PLOCALUSER, working hours ${clock(workingStartHour)} to ${clock(workingEndHour)} in UTC,`,
  "acknowledge assigned high urgency incidents and snooze them for 12 hours.",
  `Use API credential ${apiCredentialName}, webhook credential ${webhookCredentialName},`,
  "and requester pagerduty-smoke@example.test.",
].join(" ");

const generated = await request(`${apiUrl}/ai/generate-workflow`, {
  method: "POST",
  headers,
  body: JSON.stringify({ prompt }),
});
if (
  generated.mode !== "fallback"
  || generated.aiError
  || !Array.isArray(generated.nodes)
  || generated.nodes[0]?.type !== "pagerduty_incident"
) {
  throw new Error(`prompt did not compile the deterministic PagerDuty workflow: ${JSON.stringify(generated)}`);
}
const workflow = {
  dslVersion: generated.dslVersion,
  templatePolicy: generated.templatePolicy,
  id: generated.id,
  name: generated.name,
  metadata: generated.metadata,
  nodes: generated.nodes,
  edges: generated.edges,
};
await request(`${apiUrl}/workflows/save`, {
  method: "POST",
  headers,
  body: JSON.stringify(workflow),
});

const triggerNode = workflow.nodes.find((node) => node.type === "pagerduty_incident");
if (!triggerNode) throw new Error("generated workflow omitted the PagerDuty trigger");
const callbackPath = `/webhooks/pagerduty/${encodeURIComponent(workflow.id)}/${encodeURIComponent(triggerNode.id)}`;
const rawBody = JSON.stringify({
  event: {
    id: eventId,
    event_type: "incident.triggered",
    occurred_at: new Date(Date.now() - 60_000).toISOString(),
    data: {
      type: "incident",
      id: incidentId,
      title: `Prompt-generated PagerDuty incident ${stamp}`,
      urgency: "high",
      service: { id: "PLOCALSERVICE", type: "service_reference" },
    },
  },
});
const signature = `v1=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;
const delivery = {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-pagerduty-signature": signature,
  },
  body: rawBody,
};
const accepted = await request(`${apiUrl}${callbackPath}`, delivery);
if (!accepted.ok || accepted.duplicate || typeof accepted.runId !== "string") {
  throw new Error("first PagerDuty delivery did not create one workflow run");
}

const snapshot = await pollRun(accepted.runId);
const nodeStatuses = Object.fromEntries(
  snapshot.nodes.map((node) => [node.nodeId, node.status]),
);
if (snapshot.run.status !== "succeeded") {
  throw new Error(`prompt-generated PagerDuty run failed: ${JSON.stringify(snapshot)}`);
}
for (const nodeId of [
  "on_pagerduty",
  "load_incident",
  "evaluate_policy",
  "acknowledge_incident",
  "snooze_incident",
  "action_evidence",
]) {
  if (nodeStatuses[nodeId] !== "succeeded") {
    throw new Error(`${nodeId} ended as ${nodeStatuses[nodeId]}`);
  }
}
if (nodeStatuses.ignored_evidence !== "skipped") {
  throw new Error(`no-action evidence ended as ${nodeStatuses.ignored_evidence}`);
}

const evidenceBeforeDuplicate = await request(`${simulatorUrl}/requests`);
const providerCalls = evidenceBeforeDuplicate.requests.filter(
  (entry) => entry.provider === "pagerduty" && entry.path.includes(incidentId),
);
const methods = providerCalls.map((entry) => entry.method);
if (methods.join(",") !== "GET,PUT,POST") {
  throw new Error(`expected PagerDuty GET,PUT,POST; observed ${methods.join(",")}`);
}

const duplicate = await request(`${apiUrl}${callbackPath}`, delivery);
if (!duplicate.ok || duplicate.duplicate !== true || duplicate.runId !== accepted.runId) {
  throw new Error("duplicate PagerDuty delivery did not converge on the original run");
}
await new Promise((resolve) => setTimeout(resolve, 250));
const evidenceAfterDuplicate = await request(`${simulatorUrl}/requests`);
const duplicateCallCount = evidenceAfterDuplicate.requests.filter(
  (entry) => entry.provider === "pagerduty" && entry.path.includes(incidentId),
).length;
if (duplicateCallCount !== providerCalls.length) {
  throw new Error("duplicate PagerDuty delivery repeated an external effect");
}

const simulatorIncident = await request(
  `${simulatorUrl}/pagerduty/incidents/${encodeURIComponent(incidentId)}`,
);
if (
  simulatorIncident.incident?.status !== "acknowledged"
  || typeof simulatorIncident.incident?.snoozed_until !== "string"
) {
  throw new Error("simulator did not persist the acknowledge and snooze effects");
}

console.log(JSON.stringify({
  ok: true,
  generationMode: "deterministic_recipe",
  workflowId: workflow.id,
  triggerNodeId: triggerNode.id,
  runId: accepted.runId,
  incidentId,
  providerMethods: methods,
  snoozeSeconds: 43_200,
  duplicateCollapsed: true,
  aiUsed: false,
}, null, 2));
