/** PagerDuty incident read, deterministic policy, and mutation tools. */

import { z } from "zod";

import { fetchHttpTarget } from "../http-policy";
import { localIntegrationSimulatorEndpoint } from "../local-integration-simulator";
import { parseLocalMinute, windowContains, zonedClock } from "../zoned-window";
import {
  fireIntegrationRecorder,
  gateIntegrationCall,
  type GateResult,
  type IntegrationToolName,
  safeParseJson,
} from "./shared";

const pagerDutyRegion = z.enum(["us", "eu"]);

const pagerDutyIncident = z.object({
  id: z.string().min(1),
  status: z.enum(["triggered", "acknowledged", "resolved"]),
  title: z.string().nullable(),
  urgency: z.string().nullable(),
  serviceId: z.string().nullable(),
  assignedUserIds: z.array(z.string()),
});

const pagerDutyConnectionInput = z.object({
  /** Stored credential name (kind: `pagerduty_api_token`). */
  credential: z.string().min(1),
  /** PagerDuty requires a From header containing a valid account email. */
  requesterEmail: z.email(),
  /** PagerDuty account data residency. */
  region: pagerDutyRegion.optional().default("us"),
  /** Optional per-flow outbound call ceiling. */
  rateLimitPerMin: z.number().int().min(1).max(10_000).optional(),
});

const pagerDutyIncidentGetInput = pagerDutyConnectionInput.extend({
  incidentId: z.string().min(1).max(300),
});

const pagerDutyIncidentGetOutput = z.object({
  ok: z.boolean(),
  incident: pagerDutyIncident.optional(),
  statusCode: z.number().optional(),
  error: z.string().optional(),
  latencyMs: z.number(),
});

const pagerDutyWorkingWindow = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u),
}).refine((window) => window.start !== window.end, {
  message: "working window start and end must differ",
});

const workflowTemplateReference = z.string().regex(/^\{\{[^{}]+\}\}$/u);

const pagerDutyPolicyEvaluateInput = z.object({
  eventType: z.string().min(1).max(120),
  occurredAt: z.union([z.iso.datetime({ offset: true }), workflowTemplateReference]),
  receivedAt: z.union([z.iso.datetime({ offset: true }), workflowTemplateReference]),
  incident: z.union([pagerDutyIncident, workflowTemplateReference]),
  pagerDutyUserId: z.string().min(1).max(300),
  timeZone: z.string().min(1).max(100),
  workingHours: z.array(pagerDutyWorkingWindow).min(1).max(14),
  serviceIds: z.array(z.string().min(1).max(300)).max(100).optional().default([]),
  urgencies: z.array(z.string().min(1).max(100)).max(20).optional().default([]),
  actionableEventTypes: z.array(z.string().min(1).max(120)).max(20).optional(),
});

const pagerDutyPolicyEvaluateOutput = z.object({
  ok: z.literal(true),
  shouldAct: z.boolean(),
  reason: z.string(),
  eventOutsideWorkingHours: z.boolean(),
  receivedOutsideWorkingHours: z.boolean(),
  latencyMs: z.number(),
});

const pagerDutyMutationOutput = z.object({
  ok: z.boolean(),
  statusCode: z.number().optional(),
  error: z.string().optional(),
  latencyMs: z.number(),
});

const pagerDutyAcknowledgeInput = pagerDutyConnectionInput.extend({
  incidentId: z.string().min(1).max(300),
});

const pagerDutySnoozeInput = pagerDutyConnectionInput.extend({
  incidentId: z.string().min(1).max(300),
  durationSeconds: z.number().int().min(60).max(604_800),
});

const PAGERDUTY_RESPONSE_MAX_BYTES = 256 * 1024;
const PAGERDUTY_DEFAULT_RATE_LIMIT_PER_MIN = 120;
const PAGERDUTY_ACTIONABLE_EVENTS = new Set([
  "incident.triggered",
  "incident.reassigned",
  "incident.escalated",
  "incident.reopened",
]);

type PagerDutyToolContext = {
  orgId?: string;
  runId?: string;
  nodeId?: string;
  workflowId?: string;
};

type PagerDutyConnectionFields = z.infer<typeof pagerDutyConnectionInput>;

function pagerDutyApiBase(region: "us" | "eu"): string {
  return localIntegrationSimulatorEndpoint("/pagerduty")
    ?? (region === "eu" ? "https://api.eu.pagerduty.com" : "https://api.pagerduty.com");
}

function pagerDutyHeaders(token: string, requesterEmail: string): Record<string, string> {
  return {
    accept: "application/vnd.pagerduty+json;version=2",
    authorization: `Token token=${token}`,
    "content-type": "application/json",
    from: requesterEmail,
  };
}

function parsePagerDutyIncident(body: string): z.infer<typeof pagerDutyIncident> | null {
  const parsed = safeParseJson(body);
  const raw = parsed?.incident;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const service = record.service && typeof record.service === "object" && !Array.isArray(record.service)
    ? record.service as Record<string, unknown>
    : null;
  const assignments = Array.isArray(record.assignments) ? record.assignments : [];
  const candidate = {
    id: record.id,
    status: record.status,
    title: typeof record.title === "string" ? record.title.slice(0, 2_000) : null,
    urgency: typeof record.urgency === "string" ? record.urgency : null,
    serviceId: typeof service?.id === "string" ? service.id : null,
    assignedUserIds: assignments.flatMap((assignment) => {
      if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) return [];
      const assignee = (assignment as Record<string, unknown>).assignee;
      if (!assignee || typeof assignee !== "object" || Array.isArray(assignee)) return [];
      const id = (assignee as Record<string, unknown>).id;
      return typeof id === "string" ? [id] : [];
    }),
  };
  const result = pagerDutyIncident.safeParse(candidate);
  return result.success ? result.data : null;
}

async function gatePagerDutyCall(
  tool: Extract<IntegrationToolName, `pagerduty.${string}`>,
  input: PagerDutyConnectionFields,
  executionContext: PagerDutyToolContext,
): Promise<GateResult> {
  return gateIntegrationCall({
    orgId: executionContext.orgId,
    tool,
    credentialKind: "pagerduty_api_token",
    credentialName: input.credential,
    rateLimitPerMin: input.rateLimitPerMin ?? PAGERDUTY_DEFAULT_RATE_LIMIT_PER_MIN,
  });
}

async function recordPagerDutyCall(input: {
  tool: Extract<IntegrationToolName, `pagerduty.${string}`>;
  credentialName: string;
  executionContext: PagerDutyToolContext;
  ok: boolean;
  statusCode?: number;
  error?: string;
  latencyMs: number;
}): Promise<void> {
  if (!input.executionContext.orgId) return;
  await fireIntegrationRecorder({
    orgId: input.executionContext.orgId,
    tool: input.tool,
    credentialName: input.credentialName,
    executionContext: input.executionContext,
    ok: input.ok,
    statusCode: input.statusCode,
    error: input.error,
    latencyMs: input.latencyMs,
  });
}

/**
 * Safe-default working-hours evaluator. Invalid policy data is treated as
 * working time, so malformed configuration cannot authorize mutations.
 *
 * Zone resolution and midnight-crossing matching come from `zoned-window.ts`,
 * shared with the generic `time.window` tool. The BIAS stays here: that tool
 * rejects malformed configuration, this one absorbs it as "working hours".
 */
export function isWithinPagerDutyWorkingHours(
  at: Date,
  timeZone: string,
  windows: Array<{ days: number[]; start: string; end: string }>,
): boolean {
  if (windows.length === 0) return true;
  const clock = zonedClock(at, timeZone);
  if (!clock) return true;
  for (const window of windows) {
    const start = parseLocalMinute(window.start);
    const end = parseLocalMinute(window.end);
    if (start === null || end === null || start === end || window.days.length === 0) return true;
    if (windowContains(clock, window.days, start, end)) return true;
  }
  return false;
}

export const pagerDutyIncidentGetTool = {
  name: "pagerduty.incident.get" as const,
  description: "Read one authoritative PagerDuty incident using a stored API token.",
  inputSchema: pagerDutyIncidentGetInput,
  outputSchema: pagerDutyIncidentGetOutput,
  inputExample: {
    credential: "pagerduty-api",
    requesterEmail: "operator@example.com",
    region: "us",
    incidentId: "{{context.on_pagerduty.output.event.incidentId}}",
  },
  writeSide: false as const,
  async execute(
    input: z.infer<typeof pagerDutyIncidentGetInput>,
    _context: Record<string, unknown>,
    executionContext: PagerDutyToolContext,
  ): Promise<z.infer<typeof pagerDutyIncidentGetOutput>> {
    const start = Date.now();
    const gate = await gatePagerDutyCall("pagerduty.incident.get", input, executionContext);
    if (!gate.ok) {
      const latencyMs = Date.now() - start;
      await recordPagerDutyCall({
        tool: "pagerduty.incident.get",
        credentialName: input.credential,
        executionContext,
        ok: false,
        error: gate.error,
        latencyMs,
      });
      return { ok: false, error: gate.error, latencyMs };
    }
    const result = await fetchHttpTarget(
      `${pagerDutyApiBase(input.region)}/incidents/${encodeURIComponent(input.incidentId)}`,
      {
        method: "GET",
        headers: pagerDutyHeaders(gate.credentialSecret, input.requesterEmail),
        maxResponseBytes: PAGERDUTY_RESPONSE_MAX_BYTES,
      },
    ).catch(() => null);
    const latencyMs = Date.now() - start;
    const incident = result?.ok ? parsePagerDutyIncident(result.body) : null;
    const ok = Boolean(result?.ok && incident && incident.id === input.incidentId);
    const error = ok ? undefined : `pagerduty incident read failed${result ? ` (${result.statusCode})` : ""}`;
    await recordPagerDutyCall({
      tool: "pagerduty.incident.get",
      credentialName: input.credential,
      executionContext,
      ok,
      statusCode: result?.statusCode,
      error,
      latencyMs,
    });
    return ok
      ? { ok: true, incident: incident!, statusCode: result!.statusCode, latencyMs }
      : { ok: false, statusCode: result?.statusCode, error: error!, latencyMs };
  },
};

export const pagerDutyPolicyEvaluateTool = {
  name: "pagerduty.policy.evaluate" as const,
  description: "Evaluate PagerDuty event type, assignment, filters, and working hours without an LLM.",
  inputSchema: pagerDutyPolicyEvaluateInput,
  outputSchema: pagerDutyPolicyEvaluateOutput,
  inputExample: {
    eventType: "{{context.on_pagerduty.output.event.eventType}}",
    occurredAt: "{{context.on_pagerduty.output.event.occurredAt}}",
    receivedAt: "{{context.on_pagerduty.output.event.receivedAt}}",
    incident: "{{context.load_incident.output.result.incident}}",
    pagerDutyUserId: "PAGERDUTY_USER_ID",
    timeZone: "UTC",
    workingHours: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }],
  },
  writeSide: false as const,
  async execute(
    input: z.infer<typeof pagerDutyPolicyEvaluateInput>,
  ): Promise<z.infer<typeof pagerDutyPolicyEvaluateOutput>> {
    const start = Date.now();
    const actionable = new Set(input.actionableEventTypes ?? PAGERDUTY_ACTIONABLE_EVENTS);
    const eventAt = new Date(input.occurredAt);
    const receivedAt = new Date(input.receivedAt);
    const incident = pagerDutyIncident.safeParse(input.incident);
    if (!incident.success || Number.isNaN(eventAt.getTime()) || Number.isNaN(receivedAt.getTime())) {
      return {
        ok: true,
        shouldAct: false,
        reason: "invalid_runtime_input",
        eventOutsideWorkingHours: false,
        receivedOutsideWorkingHours: false,
        latencyMs: Date.now() - start,
      };
    }
    const eventOutsideWorkingHours = !isWithinPagerDutyWorkingHours(eventAt, input.timeZone, input.workingHours);
    const receivedOutsideWorkingHours = !isWithinPagerDutyWorkingHours(receivedAt, input.timeZone, input.workingHours);
    let reason = "matched";
    if (!actionable.has(input.eventType)) reason = "event_not_actionable";
    else if (incident.data.status === "resolved") reason = "incident_resolved";
    else if (!incident.data.assignedUserIds.includes(input.pagerDutyUserId)) reason = "user_not_assigned";
    else if (input.serviceIds.length > 0 && (!incident.data.serviceId || !input.serviceIds.includes(incident.data.serviceId))) reason = "service_filtered";
    else if (input.urgencies.length > 0 && (!incident.data.urgency || !input.urgencies.includes(incident.data.urgency))) reason = "urgency_filtered";
    else if (!eventOutsideWorkingHours) reason = "event_in_working_hours";
    else if (!receivedOutsideWorkingHours) reason = "received_in_working_hours";
    return {
      ok: true,
      shouldAct: reason === "matched",
      reason,
      eventOutsideWorkingHours,
      receivedOutsideWorkingHours,
      latencyMs: Date.now() - start,
    };
  },
};

export const pagerDutyAcknowledgeTool = {
  name: "pagerduty.incident.acknowledge" as const,
  description: "Acknowledge one PagerDuty incident using a stored API token.",
  inputSchema: pagerDutyAcknowledgeInput,
  outputSchema: pagerDutyMutationOutput,
  inputExample: {
    credential: "pagerduty-api",
    requesterEmail: "operator@example.com",
    region: "us",
    incidentId: "{{context.on_pagerduty.output.event.incidentId}}",
  },
  writeSide: true as const,
  async execute(
    input: z.infer<typeof pagerDutyAcknowledgeInput>,
    _context: Record<string, unknown>,
    executionContext: PagerDutyToolContext,
  ): Promise<z.infer<typeof pagerDutyMutationOutput>> {
    const start = Date.now();
    const gate = await gatePagerDutyCall("pagerduty.incident.acknowledge", input, executionContext);
    if (!gate.ok) {
      const latencyMs = Date.now() - start;
      await recordPagerDutyCall({
        tool: "pagerduty.incident.acknowledge",
        credentialName: input.credential,
        executionContext,
        ok: false,
        error: gate.error,
        latencyMs,
      });
      return { ok: false, error: gate.error, latencyMs };
    }
    const result = await fetchHttpTarget(
      `${pagerDutyApiBase(input.region)}/incidents/${encodeURIComponent(input.incidentId)}`,
      {
        method: "PUT",
        headers: pagerDutyHeaders(gate.credentialSecret, input.requesterEmail),
        body: JSON.stringify({
          incident: {
            id: input.incidentId,
            type: "incident_reference",
            status: "acknowledged",
          },
        }),
        maxResponseBytes: PAGERDUTY_RESPONSE_MAX_BYTES,
      },
    ).catch(() => null);
    const latencyMs = Date.now() - start;
    const ok = Boolean(result?.ok);
    const error = ok ? undefined : `pagerduty acknowledge failed${result ? ` (${result.statusCode})` : ""}`;
    await recordPagerDutyCall({
      tool: "pagerduty.incident.acknowledge",
      credentialName: input.credential,
      executionContext,
      ok,
      statusCode: result?.statusCode,
      error,
      latencyMs,
    });
    return ok
      ? { ok: true, statusCode: result!.statusCode, latencyMs }
      : { ok: false, statusCode: result?.statusCode, error: error!, latencyMs };
  },
};

export const pagerDutySnoozeTool = {
  name: "pagerduty.incident.snooze" as const,
  description: "Snooze one PagerDuty incident for a bounded duration using a stored API token.",
  inputSchema: pagerDutySnoozeInput,
  outputSchema: pagerDutyMutationOutput,
  inputExample: {
    credential: "pagerduty-api",
    requesterEmail: "operator@example.com",
    region: "us",
    incidentId: "{{context.on_pagerduty.output.event.incidentId}}",
    durationSeconds: 43_200,
  },
  writeSide: true as const,
  async execute(
    input: z.infer<typeof pagerDutySnoozeInput>,
    _context: Record<string, unknown>,
    executionContext: PagerDutyToolContext,
  ): Promise<z.infer<typeof pagerDutyMutationOutput>> {
    const start = Date.now();
    const gate = await gatePagerDutyCall("pagerduty.incident.snooze", input, executionContext);
    if (!gate.ok) {
      const latencyMs = Date.now() - start;
      await recordPagerDutyCall({
        tool: "pagerduty.incident.snooze",
        credentialName: input.credential,
        executionContext,
        ok: false,
        error: gate.error,
        latencyMs,
      });
      return { ok: false, error: gate.error, latencyMs };
    }
    const result = await fetchHttpTarget(
      `${pagerDutyApiBase(input.region)}/incidents/${encodeURIComponent(input.incidentId)}/snooze`,
      {
        method: "POST",
        headers: pagerDutyHeaders(gate.credentialSecret, input.requesterEmail),
        body: JSON.stringify({ duration: input.durationSeconds }),
        maxResponseBytes: PAGERDUTY_RESPONSE_MAX_BYTES,
      },
    ).catch(() => null);
    const latencyMs = Date.now() - start;
    const ok = Boolean(result?.ok);
    const error = ok ? undefined : `pagerduty snooze failed${result ? ` (${result.statusCode})` : ""}`;
    await recordPagerDutyCall({
      tool: "pagerduty.incident.snooze",
      credentialName: input.credential,
      executionContext,
      ok,
      statusCode: result?.statusCode,
      error,
      latencyMs,
    });
    return ok
      ? { ok: true, statusCode: result!.statusCode, latencyMs }
      : { ok: false, statusCode: result?.statusCode, error: error!, latencyMs };
  },
};
