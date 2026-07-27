/** Persistent local proof of Janusly's complete recovery path. */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getLocalStackSettings } from "./local-env.mjs";

const settings = await getLocalStackSettings();
const apiUrl = process.env.JANUSLY_LOCAL_API_URL ?? settings.apiUrl;
const simulatorUrl = process.env.JANUSLY_LOCAL_SIMULATOR_URL ?? settings.simulatorUrl;
const orgId = process.env.JANUSLY_RECOVERY_LAB_ORG_ID ?? "local-recovery-lab";
const userId = "local-recovery-lab-operator";
const outputArgument = process.argv.find((argument) => argument.startsWith("--output="));
const outputPath = outputArgument ? resolve(outputArgument.slice("--output=".length)) : null;
const destroyOnly = process.argv.includes("--destroy");
const headers = {
  "content-type": "application/json",
  "x-org-id": orgId,
  "x-user-id": userId,
};

if (!settings.simulatorEnabled) {
  throw new Error("recovery lab requires JANUSLY_LOCAL_INTEGRATION_SIMULATOR=true");
}
if (!orgId.startsWith("local-recovery-lab")) {
  throw new Error("JANUSLY_RECOVERY_LAB_ORG_ID must start with local-recovery-lab");
}

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

function runLocalStack(command) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["scripts/local-stack.mjs", command], {
      stdio: "inherit",
      env: {
        ...process.env,
        JANUSLY_LOCAL_ORG_ID: orgId,
      },
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolvePromise()
      : reject(new Error(`local stack ${command} exited ${code}`)));
  });
}

async function resetSimulatorEvidence() {
  await Promise.all([
    request(`${simulatorUrl}/requests`, { method: "DELETE" }),
    request(`${simulatorUrl}/effects`, { method: "DELETE" }),
  ]);
  await setWebhookMode("success");
}

async function setWebhookMode(mode) {
  await request(`${simulatorUrl}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "webhook", mode }),
  });
}

async function pollRun(runId, acceptWaitingNodeId) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const snapshot = await request(`${apiUrl}/run?runId=${encodeURIComponent(runId)}`, { headers });
    if (acceptWaitingNodeId) {
      const waiting = snapshot.nodes.find(
        (node) => node.nodeId === acceptWaitingNodeId && node.status === "waiting",
      );
      if (waiting) return snapshot;
    }
    if (["succeeded", "failed", "cancelled"].includes(snapshot.run.status)) return snapshot;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`run ${runId} did not reach the expected state`);
}

async function triggerAndApprove(endpointKey, eventId, invoiceId) {
  const accepted = await request(`${apiUrl}/triggers/webhook/ingest`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      endpointKey,
      eventId,
      eventType: "payment.retry_requested",
      payload: { invoiceId, amountUsd: 49 },
    }),
  });
  const waiting = await pollRun(accepted.runId, "approve-retry");
  if (waiting.run.status !== "running") {
    throw new Error(`approval run ${accepted.runId} terminated before the decision`);
  }
  await request(`${apiUrl}/resume`, {
    method: "POST",
    headers,
    body: JSON.stringify({ runId: accepted.runId, nodeId: "approve-retry" }),
  });
  return accepted.runId;
}

async function destroyLab() {
  await runLocalStack("recovery-lab-cleanup");
  await resetSimulatorEvidence();
  console.log(JSON.stringify({ ok: true, destroyed: true, orgId }, null, 2));
}

if (destroyOnly) {
  await destroyLab();
  process.exit(0);
}

await request(`${apiUrl}/health`);
await request(`${simulatorUrl}/health`);
await runLocalStack("recovery-lab-cleanup");
await runLocalStack("fixtures");
await resetSimulatorEvidence();

const startedAt = Date.now();
const stamp = Date.now();
const workflowId = `local-recovery-lab-payment-${stamp}`;
const endpointKey = `recovery-lab-payment-${stamp}`;
const invoiceId = `invoice-${stamp}`;
const workflow = {
  dslVersion: "1.0",
  templatePolicy: "strict",
  id: workflowId,
  name: "Failed payment recovery lab",
  nodes: [
    {
      id: "incoming",
      type: "webhook_received",
      config: { endpointKey },
    },
    {
      id: "approve-retry",
      type: "approval",
      config: {
        title: "Approve payment retry",
        description: "Review the failed payment before retrying the provider.",
      },
    },
    {
      id: "retry-charge",
      type: "tool",
      config: {
        tool: "webhook.send",
        resultPolicy: "require_ok",
        timeoutMs: 3_000,
        input: {
          credential: "billing_webhook",
          url: "https://billing.example.com/charges/retry",
          payload: {
            invoiceId: "{{context.incoming.output.event.payload.invoiceId}}",
            amountUsd: "{{context.incoming.output.event.payload.amountUsd}}",
          },
          headers: {
            "X-Idempotency-Key": "{{context.incoming.output.event.payload.invoiceId}}",
          },
        },
      },
    },
    {
      id: "completed",
      type: "noop",
      config: { value: "payment retry accepted" },
    },
  ],
  edges: [
    { from: "incoming", to: "approve-retry" },
    { from: "approve-retry", to: "retry-charge" },
    { from: "retry-charge", to: "completed" },
  ],
};
const candidate = structuredClone(workflow);
candidate.nodes.find((node) => node.id === "retry-charge").config.timeoutMs = 10_000;

const ledgerBefore = await request(`${apiUrl}/recovery/ledger`, { headers });
await request(`${apiUrl}/workflows/save`, {
  method: "POST",
  headers,
  body: JSON.stringify(workflow),
});

await setWebhookMode("failure");
const failedRunId = await triggerAndApprove(
  endpointKey,
  `failure-${stamp}`,
  invoiceId,
);
const failed = await pollRun(failedRunId);
if (failed.run.status !== "failed") {
  throw new Error(`provider outage did not fail the workflow: ${JSON.stringify(failed.run)}`);
}

const dlq = await request(
  `${apiUrl}/v1/dlq?status=open&search=${encodeURIComponent(failedRunId)}&limit=10`,
  { headers },
);
const deadLetter = dlq.data?.find(
  (entry) => entry.runId === failedRunId && entry.nodeId === "retry-charge",
);
if (!deadLetter) throw new Error("provider failure did not create a matching dead letter");

await setWebhookMode("success");
const validationStart = await request(`${apiUrl}/dlq/validate-fix`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    deadLetterId: deadLetter.id,
    suggestedWorkflow: candidate,
    validationEffectMode: "provider_simulation",
  }),
});
if (
  validationStart.validationEffectMode !== "provider_simulation"
  || !validationStart.providerEffectNodeIds?.includes("retry-charge")
) {
  throw new Error(`validation route did not attest the provider effect: ${JSON.stringify(validationStart)}`);
}
const validation = await pollRun(validationStart.runId);
if (
  validation.run.status !== "succeeded"
  || validation.run.validationEvidenceLevel !== "provider_simulated"
) {
  throw new Error(`provider validation did not succeed strongly: ${JSON.stringify(validation.run)}`);
}
const receiptEvent = validation.events.find(
  (event) => event.type === "validation.provider.receipt",
);
if (!receiptEvent?.payload?.receipt?.effectId) {
  throw new Error("validation run has no durable provider receipt");
}

const publication = await request(`${apiUrl}/workflows/save`, {
  method: "POST",
  headers,
  body: JSON.stringify(candidate),
});
await request(`${apiUrl}/dlq/replay`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    deadLetterId: deadLetter.id,
    suggestedWorkflow: candidate,
  }),
});
const recovered = await pollRun(failedRunId);
if (recovered.run.status !== "succeeded") {
  throw new Error(`production replay did not recover: ${JSON.stringify(recovered.run)}`);
}

const duplicateRunId = await triggerAndApprove(
  endpointKey,
  `duplicate-${stamp}`,
  invoiceId,
);
const duplicate = await pollRun(duplicateRunId);
if (duplicate.run.status !== "succeeded") {
  throw new Error(`duplicate delivery run did not complete: ${JSON.stringify(duplicate.run)}`);
}

const simulatorEvidence = await request(`${simulatorUrl}/effects`);
const validationEffects = simulatorEvidence.effects.filter(
  (effect) => effect.scope === "validation" && effect.idempotencyKey === invoiceId,
);
const productionEffects = simulatorEvidence.effects.filter(
  (effect) => effect.scope === "production" && effect.idempotencyKey === invoiceId,
);
if (
  validationEffects.length !== 1
  || productionEffects.length !== 1
  || productionEffects[0].deliveryCount !== 2
) {
  throw new Error(`idempotent effect ledger is inconsistent: ${JSON.stringify(simulatorEvidence)}`);
}

const ledgerAfter = await request(`${apiUrl}/recovery/ledger`, { headers });
if (ledgerAfter.totalRecovered < ledgerBefore.totalRecovered + 1) {
  throw new Error("verified recovery ledger did not advance");
}

const elapsedMs = Date.now() - startedAt;
if (elapsedMs >= 10 * 60_000) {
  throw new Error(`recovery exceeded the 10 minute lab objective: ${elapsedMs}ms`);
}

const evidence = {
  ok: true,
  orgId,
  workflowId,
  workflowVersionId: publication.versionId,
  failedRunId,
  validationRunId: validationStart.runId,
  duplicateRunId,
  deadLetterId: deadLetter.id,
  validationEvidenceLevel: validation.run.validationEvidenceLevel,
  providerReceipt: receiptEvent.payload.receipt,
  effects: {
    validation: validationEffects[0],
    production: productionEffects[0],
    duplicateDeliveryApplied: false,
  },
  recoveryLedger: {
    before: ledgerBefore,
    after: ledgerAfter,
  },
  elapsedMs,
};

if (outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify(evidence, null, 2));
