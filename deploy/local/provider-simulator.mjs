/**
 * Local provider simulator for end-to-end Janusly validation.
 *
 * It records bounded requests, supports deterministic success/failure/
 * malformed modes, and never calls the public internet. This service is not
 * a production provider proxy.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 4010);
const dataDir = process.env.SIMULATOR_DATA_DIR ?? "/data";
const statePath = `${dataDir}/state.json`;
const requestPath = `${dataDir}/requests.jsonl`;
const pagerDutyStatePath = `${dataDir}/pagerduty-incidents.json`;
const webhookEffectsPath = `${dataDir}/webhook-effects.json`;
const bodyLimit = 1_000_000;
const webhookEffectLimit = 2_000;
const providerModes = {
  github: ["success", "failure", "malformed"],
  slack: ["success", "failure", "malformed"],
  webhook: ["success", "failure", "malformed"],
  email: ["success", "failure", "malformed"],
  pagerduty: ["success", "failure", "malformed"],
  anthropic: ["success", "failure", "malformed", "semantic_violation"],
};
const providers = Object.keys(providerModes);
const state = Object.fromEntries(providers.map((provider) => [provider, "success"]));
let recordTail = Promise.resolve();
let webhookEffectTail = Promise.resolve();
const pagerDutyIncidents = new Map();
const webhookEffects = new Map();

await mkdir(dataDir, { recursive: true });
try {
  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  for (const provider of providers) {
    if (providerModes[provider].includes(persisted[provider])) {
      state[provider] = persisted[provider];
    }
  }
} catch {
  // First boot has no state file.
}
try {
  const persistedIncidents = JSON.parse(await readFile(pagerDutyStatePath, "utf8"));
  if (Array.isArray(persistedIncidents)) {
    for (const incident of persistedIncidents) {
      if (incident && typeof incident === "object" && typeof incident.id === "string") {
        pagerDutyIncidents.set(incident.id, incident);
      }
    }
  }
} catch {
  // First boot has no PagerDuty incident state.
}
try {
  const persistedEffects = JSON.parse(await readFile(webhookEffectsPath, "utf8"));
  if (Array.isArray(persistedEffects)) {
    for (const effect of persistedEffects.slice(-webhookEffectLimit)) {
      if (effect && typeof effect === "object" && typeof effect.key === "string") {
        webhookEffects.set(effect.key, effect);
      }
    }
  }
} catch {
  // First boot has no webhook effect state.
}

function send(res, statusCode, body, contentType = "application/json") {
  const serialized = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": `${contentType}; charset=utf-8`,
    "content-length": Buffer.byteLength(serialized),
    "cache-control": "no-store",
  });
  res.end(serialized);
}

async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > bodyLimit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return { raw: "", json: null };
  try {
    return { raw, json: JSON.parse(raw) };
  } catch {
    return { raw, json: null };
  }
}

function providerFor(pathname) {
  if (pathname === "/v1/messages") return "anthropic";
  if (pathname.startsWith("/github/")) return "github";
  if (pathname.startsWith("/slack/")) return "slack";
  if (pathname === "/webhook" || pathname.startsWith("/webhook/")) return "webhook";
  if (pathname === "/email/send") return "email";
  if (pathname.startsWith("/pagerduty/")) return "pagerduty";
  return null;
}

function pagerDutyIncident(id) {
  const existing = pagerDutyIncidents.get(id);
  if (existing) return existing;
  const incident = {
    id,
    type: "incident",
    status: "triggered",
    title: `Local PagerDuty incident ${id}`,
    urgency: "high",
    service: { id: "PLOCALSERVICE", type: "service_reference", summary: "Local service" },
    assignments: [{
      at: new Date().toISOString(),
      assignee: { id: "PLOCALUSER", type: "user_reference", summary: "Local responder" },
    }],
  };
  pagerDutyIncidents.set(id, incident);
  return incident;
}

async function persistPagerDutyIncidents() {
  await writeFile(
    pagerDutyStatePath,
    `${JSON.stringify([...pagerDutyIncidents.values()], null, 2)}\n`,
    "utf8",
  );
}

async function recordRequest(provider, req, url, body) {
  const entry = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    provider,
    method: req.method,
    path: url.pathname,
    target: url.searchParams.get("target"),
    idempotencyKey: typeof req.headers["x-idempotency-key"] === "string"
      ? req.headers["x-idempotency-key"]
      : null,
    body: body.json ?? body.raw.slice(0, 4_000),
  };
  const write = recordTail.then(async () => {
    const retained = (await listRequests()).slice(-199);
    retained.push(entry);
    await writeFile(requestPath, `${retained.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  });
  recordTail = write.catch(() => {});
  await write;
  return entry;
}

async function listRequests() {
  try {
    const lines = (await readFile(requestPath, "utf8")).trim().split("\n").filter(Boolean);
    return lines.slice(-200).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function webhookSimulationScope(req) {
  return req.headers["x-janusly-simulation-scope"] === "validation"
    ? "validation"
    : "production";
}

async function persistWebhookEffects() {
  await writeFile(
    webhookEffectsPath,
    `${JSON.stringify([...webhookEffects.values()], null, 2)}\n`,
    "utf8",
  );
}

async function recordWebhookEffect(req, url, entry) {
  const idempotencyKey = typeof req.headers["x-idempotency-key"] === "string"
    ? req.headers["x-idempotency-key"].trim() || null
    : null;
  const target = url.searchParams.get("target") ?? url.pathname;
  const scope = webhookSimulationScope(req);
  const key = JSON.stringify([scope, target, idempotencyKey ?? entry.id]);

  const operation = webhookEffectTail.then(async () => {
    const existing = idempotencyKey ? webhookEffects.get(key) : null;
    if (existing) {
      existing.deliveryCount = Number(existing.deliveryCount ?? 1) + 1;
      existing.lastRequestId = entry.id;
      existing.lastReceivedAt = entry.receivedAt;
      await persistWebhookEffects();
      return {
        kind: "provider_simulation_receipt",
        version: 1,
        provider: "webhook",
        operation: "deliver",
        scope,
        effectId: existing.effectId,
        idempotencyKey,
        applied: false,
        duplicate: true,
        requestId: entry.id,
      };
    }

    const effect = {
      key,
      effectId: crypto.randomUUID(),
      scope,
      target,
      idempotencyKey,
      firstRequestId: entry.id,
      lastRequestId: entry.id,
      createdAt: entry.receivedAt,
      lastReceivedAt: entry.receivedAt,
      deliveryCount: 1,
    };
    webhookEffects.set(key, effect);
    while (webhookEffects.size > webhookEffectLimit) {
      const oldest = webhookEffects.keys().next().value;
      if (typeof oldest !== "string") break;
      webhookEffects.delete(oldest);
    }
    await persistWebhookEffects();
    return {
      kind: "provider_simulation_receipt",
      version: 1,
      provider: "webhook",
      operation: "deliver",
      scope,
      effectId: effect.effectId,
      idempotencyKey,
      applied: true,
      duplicate: false,
      requestId: entry.id,
    };
  });
  webhookEffectTail = operation.catch(() => {});
  return operation;
}

function githubResponse(pathname, mode, entry) {
  if (mode === "failure") return [503, { message: "simulated GitHub outage" }];
  const comment = /\/issues\/\d+\/comments$/.test(pathname);
  if (mode === "malformed") return [201, comment ? { id: 43 } : { number: 42 }];
  return comment
    ? [201, { id: 43, html_url: `http://localhost:${port}/ui/comments/43`, requestId: entry.id }]
    : [201, { number: 42, html_url: `http://localhost:${port}/ui/issues/42`, requestId: entry.id }];
}

function anthropicResponse(mode, entry, body) {
  if (mode === "failure") {
    return [
      503,
      {
        type: "error",
        error: {
          type: "api_error",
          message: "simulated Anthropic outage",
        },
      },
    ];
  }
  if (mode === "malformed") {
    return [200, { id: `msg_${entry.id}`, type: "message" }];
  }

  const assessment = mode === "semantic_violation"
    ? {
        decision: "hold",
        riskScore: 0.92,
        reason: "The model could not verify the retry against the business policy.",
      }
    : {
        decision: "retry",
        riskScore: 0.12,
        reason: "The retry is within the configured business policy.",
      };
  const text = JSON.stringify(assessment);
  return [
    200,
    {
      id: `msg_${entry.id.replaceAll("-", "")}`,
      type: "message",
      role: "assistant",
      model:
        typeof body.json?.model === "string"
          ? body.json.model
          : "claude-haiku-4-5-20251001",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 40,
        output_tokens: Math.max(1, Math.ceil(text.length / 4)),
      },
    },
  ];
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `localhost:${port}`}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      send(res, 200, { ok: true, service: "janusly-local-provider-simulator", state });
      return;
    }
    if (req.method === "GET" && url.pathname === "/requests") {
      send(res, 200, { requests: await listRequests() });
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/requests") {
      await rm(requestPath, { force: true });
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/effects") {
      await webhookEffectTail;
      send(res, 200, { effects: [...webhookEffects.values()] });
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/effects") {
      await webhookEffectTail;
      webhookEffects.clear();
      await rm(webhookEffectsPath, { force: true });
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/control") {
      const body = await readBody(req);
      const provider = body.json?.provider;
      const mode = body.json?.mode;
      if (
        !providers.includes(provider)
        || !providerModes[provider].includes(mode)
      ) {
        send(res, 400, { error: "provider and mode must be valid closed values" });
        return;
      }
      state[provider] = mode;
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      send(res, 200, { ok: true, state });
      return;
    }

    const provider = providerFor(url.pathname);
    if (!provider) {
      send(res, 404, { error: "not_found" });
      return;
    }

    const body = await readBody(req);
    const entry = await recordRequest(provider, req, url, body);
    const mode = state[provider];

    if (provider === "anthropic") {
      if (req.method !== "POST") {
        send(res, 405, { error: "method_not_allowed" });
        return;
      }
      const [statusCode, payload] = anthropicResponse(mode, entry, body);
      send(res, statusCode, payload);
      return;
    }

    if (provider === "pagerduty") {
      if (mode === "failure") {
        send(res, 503, { error: "simulated PagerDuty outage" });
        return;
      }
      const incidentMatch = /^\/pagerduty\/incidents\/([^/]+)$/u.exec(url.pathname);
      const snoozeMatch = /^\/pagerduty\/incidents\/([^/]+)\/snooze$/u.exec(url.pathname);
      if (req.method === "GET" && incidentMatch) {
        if (mode === "malformed") send(res, 200, { incident: { id: incidentMatch[1] } });
        else send(res, 200, { incident: pagerDutyIncident(incidentMatch[1]) });
        return;
      }
      if (req.method === "PUT" && incidentMatch) {
        if (
          body.json?.incident?.id !== incidentMatch[1]
          || body.json?.incident?.status !== "acknowledged"
        ) {
          send(res, 400, { error: "invalid incident update" });
          return;
        }
        const incident = pagerDutyIncident(incidentMatch[1]);
        incident.status = "acknowledged";
        incident.last_status_change_at = new Date().toISOString();
        await persistPagerDutyIncidents();
        send(res, 200, { incident });
        return;
      }
      if (req.method === "POST" && snoozeMatch) {
        const incident = pagerDutyIncident(snoozeMatch[1]);
        const duration = Number(body.json?.duration);
        if (!Number.isInteger(duration) || duration < 60 || duration > 604_800) {
          send(res, 400, { error: "invalid snooze duration" });
          return;
        }
        incident.status = "acknowledged";
        incident.snoozed_until = new Date(Date.now() + duration * 1000).toISOString();
        await persistPagerDutyIncidents();
        send(res, 201, { incident });
        return;
      }
      send(res, 404, { error: "not_found" });
      return;
    }

    if (provider === "github") {
      const [statusCode, payload] = githubResponse(url.pathname, mode, entry);
      send(res, statusCode, payload);
      return;
    }
    if (provider === "slack") {
      if (mode === "success") send(res, 200, "ok", "text/plain");
      else if (mode === "failure") send(res, 503, "simulated_slack_outage", "text/plain");
      else send(res, 400, "invalid_payload", "text/plain");
      return;
    }
    if (provider === "webhook") {
      if (mode === "failure") send(res, 503, { error: "simulated webhook outage" });
      else {
        const receipt = await recordWebhookEffect(req, url, entry);
        if (mode === "malformed") send(res, 200, "unexpected", "text/plain");
        else send(res, 202, { accepted: true, requestId: entry.id, receipt });
      }
      return;
    }
    if (mode === "failure") send(res, 503, { error: "simulated email outage" });
    else if (mode === "malformed") send(res, 202, { accepted: true });
    else send(res, 202, { id: `local-email-${entry.id}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send(res, message === "request body too large" ? 413 : 500, { error: message });
  }
});

server.listen(port, host, () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  console.log(`[provider-simulator] listening on http://${host}:${listeningPort}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
