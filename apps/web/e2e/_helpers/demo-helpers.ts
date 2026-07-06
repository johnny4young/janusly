/**
 * Shared helpers for the demo-templates e2e spec. Driven against the
 * live API with dev-headers auth so the spec can seed credentials, save
 * workflows, trigger runs, and poll terminal state without leaning on the
 * web UI for orchestration. The e2e harness sets `E2E_API_URL` to the API
 * port it owns; the localhost:3001 fallback is only for direct manual runs.
 *
 * Keep these helpers narrow to what the demo spec actually needs — they
 * are not a general-purpose API client and intentionally do not retry.
 */

import type { APIRequestContext } from "@playwright/test";

const API_URL = process.env.E2E_API_URL ?? "http://localhost:3001";
const ORG_ID = "default";
const USER_ID = "dev-user";

export const DEMO_TEMPLATE_IDS = {
  flagship: ["incident-triage", "refund-triage-approval", "failed-workflow-recovery"],
  supporting: ["monthly-report-pdf", "multi-agent-decision", "mcp-notion-summary", "bulk-classify-loop"],
} as const;

export const ALL_DEMO_TEMPLATE_IDS = [...DEMO_TEMPLATE_IDS.flagship, ...DEMO_TEMPLATE_IDS.supporting];

type Json = Record<string, unknown>;

function devHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-org-id": ORG_ID,
    "x-user-id": USER_ID,
  };
}

async function apiGet(request: APIRequestContext, path: string): Promise<Json> {
  const response = await request.get(`${API_URL}${path}`, { headers: devHeaders() });
  if (!response.ok()) {
    throw new Error(`GET ${path} failed: ${response.status()} ${await response.text()}`);
  }
  return response.json();
}

async function apiPost(request: APIRequestContext, path: string, body: Json): Promise<Json> {
  const response = await request.post(`${API_URL}${path}`, {
    headers: devHeaders(),
    data: body,
  });
  if (!response.ok()) {
    throw new Error(`POST ${path} failed: ${response.status()} ${await response.text()}`);
  }
  return response.json();
}

export async function listTemplates(request: APIRequestContext): Promise<Json[]> {
  const data = (await apiGet(request, "/templates")) as { templates?: Json[] } | Json[];
  if (Array.isArray(data)) return data;
  return data.templates ?? [];
}

export async function loadTemplate(request: APIRequestContext, templateId: string): Promise<Json> {
  const templates = await listTemplates(request);
  const match = templates.find((t) => (t as { id?: string }).id === templateId);
  if (!match) throw new Error(`Template not found: ${templateId}`);
  return (match as { workflow: Json }).workflow;
}

export async function seedCredential(
  request: APIRequestContext,
  args: { name: string; kind: string; secretRef: string },
): Promise<{ id: string }> {
  return (await apiPost(request, "/credentials", { name: args.name, kind: args.kind, secretRef: args.secretRef })) as { id: string };
}

export async function startRun(
  request: APIRequestContext,
  workflow: Json,
  input?: Json,
): Promise<{ runId: string }> {
  const body: Json = input === undefined ? workflow : { workflow, input };
  return (await apiPost(request, "/start", body)) as { runId: string };
}

type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled"]);

export type DemoRunNode = { nodeId: string; status: string; stateJson?: { output?: unknown } | null; errorJson?: unknown };

export type RunSnapshot = {
  status: RunStatus;
  run: Json;
  nodes: DemoRunNode[];
  events: Json[];
};

export async function getRun(request: APIRequestContext, runId: string): Promise<RunSnapshot> {
  const data = (await apiGet(request, `/run?runId=${encodeURIComponent(runId)}`)) as {
    run: { status: RunStatus } & Json;
    nodes: DemoRunNode[];
    events: Json[];
  };
  return {
    status: data.run.status,
    run: data.run,
    nodes: data.nodes,
    events: data.events,
  };
}

/**
 * Poll `/run` until the run reaches `succeeded`, `failed`, or `cancelled`.
 * `maxMs` budget defaults to 30s — most demos terminate in 2-5s. Returns
 * the final snapshot.
 */
export async function pollUntilTerminal(
  request: APIRequestContext,
  runId: string,
  maxMs: number = 30_000,
): Promise<RunSnapshot> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const snapshot = await getRun(request, runId);
    if (TERMINAL_STATUSES.has(snapshot.status)) return snapshot;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for run ${runId} to terminate (last status unknown)`);
}

/**
 * Poll `/run` until either the whole run terminates OR the specified
 * node lands in `waiting` state (approval / human_form paused). Returns
 * the snapshot at the first matching condition.
 */
export async function pollUntilWaitingOrTerminal(
  request: APIRequestContext,
  runId: string,
  waitingNodeId: string,
  maxMs: number = 30_000,
): Promise<RunSnapshot> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const snapshot = await getRun(request, runId);
    if (TERMINAL_STATUSES.has(snapshot.status)) return snapshot;
    const waitingNode = snapshot.nodes.find((n) => n.nodeId === waitingNodeId);
    if (waitingNode && waitingNode.status === "waiting") return snapshot;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for run ${runId} to pause on ${waitingNodeId}`);
}

export async function resumeApproval(
  request: APIRequestContext,
  runId: string,
  nodeId: string,
): Promise<void> {
  await apiPost(request, "/resume", { runId, nodeId });
}

/**
 * Drive a webhook-trigger node from waiting → succeeded by POSTing the
 * inbound payload to `/resume`. Webhook nodes pause on `/start` (they
 * wait for an external source); the payload becomes the node's output
 * so downstream `{{context.<nodeId>.output.X}}` templates resolve.
 */
export async function resumeWebhook(
  request: APIRequestContext,
  runId: string,
  nodeId: string,
  payload: Json,
): Promise<void> {
  await apiPost(request, "/resume", { runId, nodeId, input: payload });
}

export async function findDeadLetterForRun(
  request: APIRequestContext,
  runId: string,
): Promise<{ id: string; runId: string; nodeId: string; errorJson?: unknown } | null> {
  const data = (await apiGet(request, "/dlq?limit=100")) as Array<{
    id: string;
    runId: string;
    nodeId: string;
    errorJson?: unknown;
  }>;
  return data.find((row) => row.runId === runId) ?? null;
}

export async function fetchReadiness(
  request: APIRequestContext,
  workflow: Json,
): Promise<{ status: string; issues: Array<{ code: string; message: string }> }> {
  return (await apiPost(request, "/workflows/readiness", { workflow })) as {
    status: string;
    issues: Array<{ code: string; message: string }>;
  };
}

/**
 * Sandbox-validate a proposed fix for a dead letter. Returns the validation
 * run id (a writes-skipped replay of `suggestedWorkflow` from the failing
 * node) — poll it with {@link pollUntilTerminal}: `succeeded` = the sandbox
 * accepts the fix, `failed` = it rejects it.
 */
export async function validateFix(
  request: APIRequestContext,
  deadLetterId: string,
  suggestedWorkflow: Json,
): Promise<string> {
  const result = (await apiPost(request, "/dlq/validate-fix", { deadLetterId, suggestedWorkflow })) as { runId: string };
  return result.runId;
}

/** Replay a dead letter by id (production replay of its snapshot). */
export async function replayDeadLetter(request: APIRequestContext, deadLetterId: string): Promise<void> {
  await apiPost(request, "/dlq/replay", { deadLetterId });
}

/** Read a dead letter's current status (`open` / `replayed` / `resolved`), or null if gone. */
export async function deadLetterStatus(request: APIRequestContext, deadLetterId: string): Promise<string | null> {
  const rows = (await apiGet(request, "/dlq?limit=200")) as Array<{ id: string; status?: string }>;
  return rows.find((r) => r.id === deadLetterId)?.status ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
