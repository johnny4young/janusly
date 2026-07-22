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
const bodyLimit = 1_000_000;
const providers = ["github", "slack", "webhook", "email"];
const modes = ["success", "failure", "malformed"];
const state = Object.fromEntries(providers.map((provider) => [provider, "success"]));
let recordTail = Promise.resolve();

await mkdir(dataDir, { recursive: true });
try {
  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  for (const provider of providers) {
    if (modes.includes(persisted[provider])) state[provider] = persisted[provider];
  }
} catch {
  // First boot has no state file.
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
  if (pathname.startsWith("/github/")) return "github";
  if (pathname.startsWith("/slack/")) return "slack";
  if (pathname === "/webhook") return "webhook";
  if (pathname === "/email/send") return "email";
  return null;
}

async function recordRequest(provider, req, url, body) {
  const entry = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    provider,
    method: req.method,
    path: url.pathname,
    target: url.searchParams.get("target"),
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

function githubResponse(pathname, mode, entry) {
  if (mode === "failure") return [503, { message: "simulated GitHub outage" }];
  const comment = /\/issues\/\d+\/comments$/.test(pathname);
  if (mode === "malformed") return [201, comment ? { id: 43 } : { number: 42 }];
  return comment
    ? [201, { id: 43, html_url: `http://localhost:${port}/ui/comments/43`, requestId: entry.id }]
    : [201, { number: 42, html_url: `http://localhost:${port}/ui/issues/42`, requestId: entry.id }];
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
    if (req.method === "POST" && url.pathname === "/control") {
      const body = await readBody(req);
      const provider = body.json?.provider;
      const mode = body.json?.mode;
      if (!providers.includes(provider) || !modes.includes(mode)) {
        send(res, 400, { error: "provider and mode must be valid closed values" });
        return;
      }
      state[provider] = mode;
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      send(res, 200, { ok: true, state });
      return;
    }

    const provider = providerFor(url.pathname);
    if (req.method !== "POST" || !provider) {
      send(res, 404, { error: "not_found" });
      return;
    }

    const body = await readBody(req);
    const entry = await recordRequest(provider, req, url, body);
    const mode = state[provider];

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
      else if (mode === "malformed") send(res, 200, "unexpected", "text/plain");
      else send(res, 202, { accepted: true, requestId: entry.id });
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
  console.log(`[provider-simulator] listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
