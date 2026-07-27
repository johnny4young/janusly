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
const localLlmEnvironment = {
  ANTHROPIC_API_KEY: "local-anthropic-simulator-key",
  ANTHROPIC_BASE_URL: "http://provider-simulator:4010/v1",
  JANUSLY_LLM_SIMULATED_PROVIDERS: "anthropic",
};
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

function runLocalStack(command, environment = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["scripts/local-stack.mjs", command], {
      stdio: "inherit",
      env: {
        ...process.env,
        JANUSLY_LOCAL_ORG_ID: orgId,
        ...environment,
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
  await Promise.all([
    setProviderMode("webhook", "success"),
    setProviderMode("anthropic", "semantic_violation"),
  ]);
}

async function setProviderMode(provider, mode) {
  await request(`${simulatorUrl}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, mode }),
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

async function pollSemanticQuarantine(runId) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const snapshot = await request(
      `${apiUrl}/run?runId=${encodeURIComponent(runId)}`,
      { headers },
    );
    const assessment = snapshot.nodes.find(
      (node) =>
        node.nodeId === "assess_payment"
        && node.status === "succeeded",
    );
    const approval = snapshot.nodes.find(
      (node) => node.nodeId === "approve-retry",
    );
    const effect = snapshot.nodes.find(
      (node) => node.nodeId === "retry-charge",
    );
    if (
      snapshot.run.status === "waiting"
      && snapshot.run.outcomeStatus === "semantic_quarantined"
      && assessment
      && approval?.status === "pending"
      && effect?.status === "pending"
    ) {
      return { snapshot, assessment };
    }
    if (["failed", "cancelled", "succeeded"].includes(snapshot.run.status)) {
      throw new Error(
        `run ${runId} terminated before semantic quarantine: ${JSON.stringify(snapshot.run)}`,
      );
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`run ${runId} did not enter semantic quarantine`);
}

async function trigger(endpointKey, eventId, invoiceId) {
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
  return accepted.runId;
}

async function approve(runId) {
  const waiting = await pollRun(runId, "approve-retry");
  if (waiting.run.status !== "running") {
    throw new Error(`approval run ${runId} terminated before the decision`);
  }
  await request(`${apiUrl}/resume`, {
    method: "POST",
    headers,
    body: JSON.stringify({ runId, nodeId: "approve-retry" }),
  });
}

async function destroyLab() {
  await runLocalStack("recovery-lab-cleanup", localLlmEnvironment);
  await resetSimulatorEvidence();
  console.log(JSON.stringify({ ok: true, destroyed: true, orgId }, null, 2));
}

if (destroyOnly) {
  await destroyLab();
  process.exit(0);
}

async function runRecoveryLab() {
  await runLocalStack("up", localLlmEnvironment);
  await request(`${apiUrl}/health`);
  await request(`${simulatorUrl}/health`);
  await runLocalStack("recovery-lab-cleanup", localLlmEnvironment);
  await runLocalStack("fixtures", localLlmEnvironment);
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
    name: "Payment outcome recovery lab",
    nodes: [
      {
        id: "incoming",
        type: "webhook_received",
        config: { endpointKey },
      },
      {
        id: "assess_payment",
        type: "ai",
        config: {
          model: "anthropic/claude-haiku-4-5-20251001",
          prompt:
            "Assess whether the incoming payment retry is safe. Return JSON with decision, riskScore, and reason.",
          responseFormat: "json",
          outputSchema: {
            type: "object",
            properties: {
              decision: {
                type: "string",
                enum: ["retry", "hold"],
              },
              riskScore: { type: "number" },
              reason: { type: "string" },
            },
            required: ["decision", "riskScore", "reason"],
          },
        },
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
      { from: "incoming", to: "assess_payment" },
      { from: "assess_payment", to: "approve-retry" },
      { from: "approve-retry", to: "retry-charge" },
      { from: "retry-charge", to: "completed" },
    ],
    recovery: {
      contract: {
        version: "2",
        failure: {
          technical: {
            terminalNodeFailure: true,
            stalledNode: true,
          },
          semantic: {
            mode: "deterministic",
            detectors: [
              {
                id: "safe-payment-retry",
                sourceNodeId: "assess_payment",
                kind: "expression",
                passWhen:
                  'context.assess_payment.output.data.decision === "retry" && context.assess_payment.output.data.riskScore <= 0.3',
                action: "quarantine",
                message:
                  "The model response is valid JSON but does not authorize a safe payment retry.",
              },
            ],
            evaluationFixtures: [
              {
                id: "safe-retry",
                sourceNodeId: "assess_payment",
                output: {
                  mode: "ai",
                  data: {
                    decision: "retry",
                    riskScore: 0.12,
                    reason: "The retry is inside policy.",
                  },
                },
                expected: "pass",
              },
              {
                id: "unsafe-retry",
                sourceNodeId: "assess_payment",
                output: {
                  mode: "ai",
                  data: {
                    decision: "hold",
                    riskScore: 0.92,
                    reason: "The retry cannot be verified.",
                  },
                },
                expected: "violation",
              },
            ],
          },
        },
        evidence: {
          required: [
            "failure_snapshot",
            "run_timeline",
            "audit_trail",
            "validation_receipt",
            "effect_receipt",
            "terminal_outcome",
          ],
        },
        effects: [
          {
            nodeId: "retry-charge",
            kind: "financial_mutation",
            idempotency: "required",
            receipt: "provider",
          },
        ],
        repairs: {
          allowed: ["retry", "config_patch"],
        },
        validation: {
          minimumEvidenceLevel: "provider_simulated",
        },
        approval: {
          productionMutation: "required",
          permission: "recovery.write",
        },
        autonomyLevel: 3,
        verification: {
          kind: "generation_bound_terminal_success",
        },
        recurrence: { windowDays: 7 },
      },
    },
  };
  const candidate = structuredClone(workflow);
  candidate.nodes.find((node) => node.id === "retry-charge").config.timeoutMs = 10_000;

  const ledgerBefore = await request(`${apiUrl}/recovery/ledger`, { headers });
  await request(`${apiUrl}/workflows/save`, {
    method: "POST",
    headers,
    body: JSON.stringify(workflow),
  });

  const failedRunId = await trigger(
    endpointKey,
    `failure-${stamp}`,
    invoiceId,
  );
  const semanticQuarantine = await pollSemanticQuarantine(failedRunId);
  const originalAssessment = semanticQuarantine.assessment.stateJson?.output;
  if (
    originalAssessment?.mode !== "ai"
    || originalAssessment?.valid !== true
    || originalAssessment?.provider !== "anthropic"
    || originalAssessment?.providerSimulated !== true
    || originalAssessment?.costUsd !== 0
    || originalAssessment?.data?.decision !== "hold"
    || Number(originalAssessment?.data?.riskScore) <= 0.3
  ) {
    throw new Error(
      `Anthropic-compatible provider did not return the expected schema-valid semantic violation: ${JSON.stringify(originalAssessment)}`,
    );
  }

  const semanticCases = await request(
    `${apiUrl}/recovery/cases?runId=${encodeURIComponent(failedRunId)}`,
    { headers },
  );
  const semanticCase = semanticCases.cases?.find(
    (entry) =>
      entry.sourceNodeId === "assess_payment"
      && entry.action === "quarantine"
      && entry.state === "contained",
  );
  if (!semanticCase) {
    throw new Error("semantic quarantine did not create a durable recovery case");
  }

  const effectsBeforeResolution = await request(`${simulatorUrl}/effects`);
  if (effectsBeforeResolution.effects.length !== 0) {
    throw new Error("semantic quarantine did not block the downstream provider effect");
  }
  const providerRequestsBeforeResolution = await request(`${simulatorUrl}/requests`);
  const semanticProviderRequest = providerRequestsBeforeResolution.requests
    .filter((entry) => entry.provider === "anthropic")
    .at(-1);
  if (!semanticProviderRequest?.id) {
    throw new Error("semantic qualification has no Anthropic-wire provider request");
  }

  const replacementOutput = {
    mode: "operator_replacement",
    valid: true,
    provider: "operator",
    data: {
      decision: "retry",
      riskScore: 0.14,
      reason: "The operator verified the retry against the payment policy.",
    },
    response: JSON.stringify({
      decision: "retry",
      riskScore: 0.14,
      reason: "The operator verified the retry against the payment policy.",
    }),
  };
  await request(
    `${apiUrl}/recovery/cases/${encodeURIComponent(semanticCase.id)}/resolve`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        decision: "replace",
        output: replacementOutput,
        reason: "Verified against the payment retry policy before any provider effect.",
      }),
    },
  );
  const resolvedSemanticCases = await request(
    `${apiUrl}/recovery/cases?runId=${encodeURIComponent(failedRunId)}&openOnly=false`,
    { headers },
  );
  const resolvedSemanticCase = resolvedSemanticCases.cases?.find(
    (entry) => entry.id === semanticCase.id,
  );
  if (resolvedSemanticCase?.state !== "verified_recovered") {
    throw new Error("semantic recovery case did not reach verified_recovered");
  }

  await setProviderMode("webhook", "failure");
  await approve(failedRunId);
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

  await setProviderMode("webhook", "success");
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
  if (
    recovered.run.status !== "succeeded"
    || recovered.run.outcomeStatus !== "semantic_recovered"
  ) {
    throw new Error(`production replay did not recover: ${JSON.stringify(recovered.run)}`);
  }

  await setProviderMode("anthropic", "success");
  const duplicateRunId = await trigger(
    endpointKey,
    `duplicate-${stamp}`,
    invoiceId,
  );
  await approve(duplicateRunId);
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

  return {
    ok: true,
    orgId,
    workflowId,
    workflowVersionId: publication.versionId,
    failedRunId,
    validationRunId: validationStart.runId,
    duplicateRunId,
    deadLetterId: deadLetter.id,
    semanticQualification: {
      evidenceLevel: "provider_simulated",
      transport: "anthropic_messages_api",
      provider: originalAssessment.provider,
      model: originalAssessment.model,
      providerRequestId: semanticProviderRequest.id,
      recoveryCaseId: semanticCase.id,
      recoveryCaseState: resolvedSemanticCase.state,
      originalData: originalAssessment.data,
      replacementData: replacementOutput.data,
      downstreamEffectBlockedBeforeResolution: true,
      finalOutcomeStatus: recovered.run.outcomeStatus,
    },
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
}

let evidence;
try {
  evidence = await runRecoveryLab();
} finally {
  // The Lab temporarily replaces the shared local API/worker provider
  // endpoint. Recreate the normal profile even when qualification fails so
  // later manual runs cannot inherit simulated LLM routing.
  await runLocalStack("up");
}

if (outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify(evidence, null, 2));
