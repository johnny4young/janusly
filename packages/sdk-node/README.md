# @janusly/sdk

> Typed TypeScript client for the Janusly HTTP API. Resource-style methods,
> async iterators for run listing and event streaming, a typed error class
> hierarchy, an opt-in retry layer, and a webhook signature verifier.
> Node 24, ESM, generated declarations, and zero runtime dependencies.

## Install

This package remains private while Janusly's licensing and distribution
posture is decided. It is nevertheless built and tested as a normal npm
artifact. Consume it from another workspace package with:

```jsonc
// package.json
"dependencies": {
  "@janusly/sdk": "workspace:*"
}
```

External registry installation is not yet supported. Maintainers can verify
the exact distributable tarball without publishing:

```bash
pnpm --filter @janusly/sdk test:package
```

That command builds `dist/`, packs only the public files, installs the tarball
into an isolated temporary consumer, and imports the public entrypoint.

## Quick start

```typescript
import { JanuslyClient } from "@janusly/sdk";

const client = new JanuslyClient({
  baseUrl: "https://api.janusly.example.com",
  orgId: "acme",
  auth: { kind: "service-token", token: process.env.JANUSLY_TOKEN! },
});

const { runId } = await client.runs.start({ workflowId: "wf-incident-triage", input: { ticketId: "T-42" } });
const final = await client.runs.pollUntilTerminal(runId, { timeoutMs: 60_000 });
console.log(final.run.status); // "succeeded" | "failed" | "cancelled" | "timed_out"
```

## Authentication

The SDK supports two auth modes. Both always send `x-org-id` so the API
can scope every request to a single tenant.

### Service-token mode (recommended for server-to-server)

```typescript
const client = new JanuslyClient({
  baseUrl: "https://api.janusly.example.com",
  orgId: "acme",
  auth: {
    kind: "service-token",
    token: process.env.JANUSLY_API_SERVICE_TOKEN!,
    userId: "integration-bot", // optional, defaults to "sdk-user"
  },
});
```

The `userId` lands in audit-log `actor.userId` rows so compliance can
distinguish SDK traffic from web / MCP / other source. Override per
integration so each one shows up distinctly in audit reads.

### Bearer mode (Supabase JWT or any bearer the API recognises)

```typescript
const client = new JanuslyClient({
  baseUrl: "https://api.janusly.example.com",
  orgId: "acme",
  auth: { kind: "bearer", token: supabaseSession.access_token },
});
```

In bearer mode the SDK sends `Authorization: Bearer <token>` but NOT
`x-user-id` — the identity is carried in the token itself (Supabase JWT
claims, etc.), and the API resolves the actor server-side.

## Configuration reference

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `baseUrl` | `string` | — | API base URL. Trailing slashes are stripped. Required. |
| `orgId` | `string` | — | Tenant scope. Sent as `x-org-id` on every request. Required. |
| `auth` | `JanuslyAuthMode` | — | Service-token or bearer. Required. |
| `userAgent` | `string` | `"janusly-sdk-node/0.0.1"` | Optional suffix appended to the SDK's User-Agent header. |
| `logger` | `JanuslyLogger` | no-op | `{ debug?, warn?, error? }` — hooks fire on retries and unexpected response shapes. |
| `retry` | `JanuslyRetryConfig` | `{ maxAttempts: 0 }` | Opt-in retry layer. See [When to opt into retries](#when-to-opt-into-retries). |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Injectable fetch for tests, proxies, or custom dispatchers. |

Each method also accepts a per-call `{ signal?, headers?, timeoutMs? }`
options object. The signal composes with the SDK's internal 30s
timeout via `AbortSignal.any` so either can cancel.

## Common use cases

### 1. Start a workflow and stream its events

```typescript
import { JanuslyClient } from "@janusly/sdk";

const client = new JanuslyClient({ baseUrl, orgId, auth });

const { runId } = await client.runs.start({
  workflowId: "wf-incident",
  input: { ticketId: "T-42" },
});

const controller = new AbortController();
setTimeout(() => controller.abort(), 5 * 60_000); // cap at 5 minutes

for await (const event of client.runs.streamEvents(runId, undefined, { signal: controller.signal })) {
  console.log(event.type, event.nodeId, event.createdAt);
  if (event.type === "node.failed") notifySlack(event);
}
```

The `for await` loop exits automatically when the run reaches a terminal
status. The iterator emits API-returned events in chronological order and
skips duplicates across poll cycles.

### 2. Wait until a run reaches a terminal status

```typescript
import { JanuslyTimeoutError } from "@janusly/sdk";

try {
  const final = await client.runs.pollUntilTerminal(runId, {
    intervalMs: 1500,
    timeoutMs: 5 * 60_000,
  });
  console.log("final status:", final.run.status);
} catch (err) {
  if (err instanceof JanuslyTimeoutError) {
    console.warn("run is still running past our deadline; will check again later");
  } else {
    throw err;
  }
}
```

Use `pollUntilTerminal` when you only care about the final outcome.
Use `streamEvents` when you need to react to individual events as they
arrive.

### 3. List runs

```typescript
for await (const run of client.runs.list({ workflowId: "wf-incident" })) {
  console.log(run.id, run.status, run.createdAt);
  if (run.status === "failed") {
    // ...inspect failures, break early when done
    break;
  }
}
```

The current API returns one capped page (`limit` defaults to 100 and the
server caps it at 200). The SDK exposes it as an async iterator so callers
can break early without buffering their own copy. If the API later adds
cursor pagination, this iterator can consume it without changing the
public method shape.

### 4. Resume a `human_form` node

The engine emits a signed `resumeToken` in the `node.waiting` event
payload when a `human_form` node pauses. Pass it verbatim:

```typescript
for await (const event of client.runs.streamEvents(runId)) {
  if (event.type === "node.waiting" && event.payload?.kind === "human_form") {
    const formData = await collectInputFromUser();
    await client.runs.resumeNode({
      runId,
      nodeId: event.nodeId!,
      input: formData,
      resumeToken: event.payload.resumeToken as string,
    });
  }
}
```

For `approval` nodes the token is optional — the API authorises by role
+ org scope.

### 5. Cancel an in-flight run

```typescript
await client.runs.cancel({ runId, reason: "superseded by a newer run" });
```

Cancelling flips the run + its non-running nodes to `cancelled` (the
worker's currently-running job drains to completion). A run that already
reached a terminal status throws `JanuslyApiError` (409).

### 6. Export a run-explain report

Exports intentionally use the unversioned artifact route so Markdown and JSON
downloads retain their raw bytes and `Content-Disposition` filename.

```typescript
import { writeFile } from "node:fs/promises";

const report = await client.reports.exportRunExplain(runId, { format: "markdown" });
await writeFile(report.filename, report.body, "utf8");
console.log(`Wrote ${report.filename} (${report.contentType})`);
```

The filename comes from the server's `Content-Disposition` header. JSON
format is also available — pass `{ format: "json" }`.

### 7. Verify an inbound Janusly webhook

Mounted in an Express-style handler. **Always pass the RAW request body**
— re-serializing a parsed object produces different bytes and breaks the
HMAC:

```typescript
import express from "express";
import { JanuslyClient, JanuslyWebhookSignatureError } from "@janusly/sdk";

const app = express();
// IMPORTANT: capture the raw body for HMAC verification, BEFORE express.json()
app.post("/webhooks/janusly", express.raw({ type: "application/json" }), (req, res) => {
  const client = new JanuslyClient({ baseUrl, orgId, auth });
  try {
    const { timestamp } = client.webhooks.verifySignature({
      body: req.body, // Buffer
      signatureHeader: req.header("x-janusly-signature") ?? "",
      secret: process.env.JANUSLY_WEBHOOK_SECRET!,
    });
    const payload = JSON.parse(req.body.toString("utf8"));
    console.log("verified webhook from", new Date(timestamp * 1000), payload);
    res.status(200).send("ok");
  } catch (err) {
    if (err instanceof JanuslyWebhookSignatureError) {
      console.warn("rejected:", err.reason);
      res.status(401).send("invalid signature");
      return;
    }
    throw err;
  }
});
```

The verifier checks three things, in order:
1. The header parses into a valid `t=<seconds>,v1=<hex>` pair (otherwise `reason: "malformed_header"`).
2. The timestamp is within ±5 minutes of the receiver's clock (configurable via `toleranceSeconds`; otherwise `reason: "timestamp_skew"`).
3. The HMAC-SHA256 over `${timestamp}.${rawBody}` matches `v1` byte-for-byte via `crypto.timingSafeEqual` (otherwise `reason: "signature_mismatch"`).

## Error handling

Every method throws a typed subclass of `JanuslyApiError` on non-2xx
responses. Use `instanceof` instead of switching on `statusCode`:

```typescript
import {
  JanuslyApiError,
  JanuslyAuthError,
  JanuslyValidationError,
  JanuslyRateLimitError,
  JanuslyProtocolError,
  JanuslyServerError,
} from "@janusly/sdk";

try {
  await client.runs.start({ workflowId, input });
} catch (err) {
  if (err instanceof JanuslyRateLimitError) {
    const waitMs = (err.retryAfterSeconds ?? 5) * 1000;
    await new Promise((r) => setTimeout(r, waitMs));
    // retry...
  } else if (err instanceof JanuslyValidationError) {
    console.error("bad input:", err.code, err.params);
  } else if (err instanceof JanuslyAuthError) {
    console.error("auth rejected — refresh the token");
  } else if (err instanceof JanuslyServerError) {
    console.error(`server error (${err.statusCode}); the opt-in retry layer would have helped here`);
  } else if (err instanceof JanuslyProtocolError) {
    console.error("the API returned an invalid v1 success envelope");
  } else if (err instanceof JanuslyApiError) {
    console.error(`HTTP ${err.statusCode}: ${err.message}`);
  } else {
    throw err; // network / abort / unknown
  }
}
```

Mapping table:

| HTTP status | Subclass | Notable fields |
| --- | --- | --- |
| 400, 422 | `JanuslyValidationError` | `code`, `params` (from `apps/api/src/error-codes.ts`) |
| 401, 403 | `JanuslyAuthError` | — |
| 429 | `JanuslyRateLimitError` | `retryAfterSeconds` parsed from `Retry-After` |
| 500–599 | `JanuslyServerError` | — |
| any other | `JanuslyApiError` (base) | `statusCode` |

A successful `/v1` response that is missing `apiVersion`, `requestId`, or
`data` throws `JanuslyProtocolError` with code
`invalid_response_envelope`. The SDK never silently casts a drifted stable
response.

A standalone `JanuslyTimeoutError extends JanuslyApiError` (with
`code: "polling_timeout"` and `statusCode: 0`) is thrown by
`runs.pollUntilTerminal` when the wall-clock deadline elapses.

Webhook verification failures throw `JanuslyWebhookSignatureError` (NOT a
subclass of `JanuslyApiError`) with a typed `reason` field.

## Best practices

### Choosing `pollUntilTerminal` vs `streamEvents`

| Use case | Pick |
| --- | --- |
| "Did this run finish? What's the final output?" | `pollUntilTerminal` |
| "React to each event as it happens (failed nodes, waiting approvals)" | `streamEvents` |
| "I want both" | Wrap `streamEvents` in your own logic; the loop exits on terminal status, so the final iteration carries the conclusion. |

When the API later gains server-sent events, the SDK swaps `streamEvents`
to consume SSE transparently. The same `for await` code keeps working
without modification.

### Cancellation via `AbortController`

Every method honours `options.signal`. Wire it to your HTTP handler's
`request.signal` (or any `AbortController` you own) so long-running
streams stop cleanly when the upstream caller disconnects:

```typescript
const controller = new AbortController();
req.on("close", () => controller.abort());

for await (const event of client.runs.streamEvents(runId, undefined, { signal: controller.signal })) {
  res.write(JSON.stringify(event) + "\n");
}
```

### When to opt into retries

The retry layer is **off by default** for predictability. Opt in when:

- Your caller is server-to-server (no UI feedback to surface the
  retry).
- The operation is **idempotent**. `POST /start` is NOT idempotent —
  retrying a 5xx on `/start` may create duplicate runs.
- You want automatic `Retry-After` respect on 429s — the SDK reads the
  header and sleeps the suggested duration before retrying.

```typescript
const client = new JanuslyClient({
  baseUrl,
  orgId,
  auth,
  retry: { maxAttempts: 3, backoffMs: 250, retryOn: [429, 502, 503, 504] },
  logger: { warn: console.warn }, // see every retry attempt
});
```

### Structured logging

Pass a `logger` to see:
- Every retry attempt with `delayMs` + `statusCode` + `attempt` number.
- Non-JSON response bodies on success paths (drift signal).
- JSON parse failures.

```typescript
const client = new JanuslyClient({
  baseUrl,
  orgId,
  auth,
  logger: {
    debug: (msg, meta) => log.debug({ msg, meta }),
    warn: (msg, meta) => log.warn({ msg, meta }),
    error: (msg, meta) => log.error({ msg, meta }),
  },
});
```

### Multi-tenant scope hygiene

`orgId` is set at constructor time and sent on every request. The SDK
intentionally does NOT expose a per-call `orgId` override — that would
make it too easy to leak across tenants. To operate on multiple orgs,
construct one client per org:

```typescript
const clients = new Map<string, JanuslyClient>();
for (const orgId of orgIds) {
  clients.set(orgId, new JanuslyClient({ baseUrl, orgId, auth }));
}
```

### Don't re-serialize webhook bodies before verifying

The HMAC is computed over the exact bytes the server sent. If your HTTP
framework parses JSON before your handler runs, the re-stringified form
likely has different key order or whitespace, and verification will
fail. Capture the raw body via `express.raw({ type: "application/json" })`,
Fastify's `rawBody` plugin, or your framework's equivalent.

## TypeScript notes

- Target: ES2023, ESM modules, strict mode.
- Types are inlined — every DTO + class is exported from
  `@janusly/sdk` (no separate `@types/janusly__sdk`).
- Node 24 is required (matches the monorepo `engines.node` contract).
- `npm run build` emits ESM JavaScript, declarations, declaration maps, and
  source maps under `dist/`; package exports never point at TypeScript source.
- Tested against Vitest 4. Zero runtime deps; `vitest` +
  `@types/node` are dev-only.

## Versioning

`v0.0.1` — initial private workspace version. Future published versions follow
[SemVer](https://semver.org/); release notes live in the repository root
`CHANGELOG.md`.

## License

Internal — workspace-private package.
