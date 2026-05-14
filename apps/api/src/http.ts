/**
 * Small request/response helpers for the API route modules — the project
 * intentionally uses Node's `http.createServer` directly (no Express /
 * Fastify) so this file owns the few primitives every route needs:
 * status-bearing errors, body-size-capped JSON read, JSON / SSE writers,
 * and CORS headers.
 *
 * Used by every route module under `apps/api/src/routes/*` and the dispatcher in `apps/api/src/server.ts`.
 *
 * Invariants:
 * - `readJson` enforces `API_MAX_JSON_BODY_BYTES` and rejects 413 when
 *   exceeded — callers shouldn't read the stream themselves.
 * - `corsHeaders` returns `null` for the Origin when the request came from
 *   a non-allowlisted origin; never `*` with credentials.
 */

import http from "http";

/** `Error` carrying an HTTP status. `server.ts` reads `statusCode` to map throws to responses. */
export type HttpError = Error & { statusCode?: number };

/** Build an `HttpError` with a fixed status. The route handler's catch maps it to the response. */
export function httpError(message: string, statusCode: number): HttpError {
  const err = new Error(message) as HttpError;
  err.statusCode = statusCode;
  return err;
}

const DEFAULT_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174";

/** `ServerResponse` augmented with the request `Origin` so `corsHeaders` can resolve it. */
export type CorsAwareResponse = http.ServerResponse & { requestOrigin?: string };

function getAllowedOrigins() {
  const configured = process.env.API_ALLOWED_ORIGINS ?? DEFAULT_ORIGINS;
  return configured.split(",").map(origin => origin.trim()).filter(Boolean);
}

/** Build the CORS header dict against `API_ALLOWED_ORIGINS`. Echoes the origin only when it's allowlisted. */
export function corsHeaders(res: http.ServerResponse) {
  const origin = (res as CorsAwareResponse).requestOrigin;
  const allowedOrigins = getAllowedOrigins();
  const allowAny = allowedOrigins.includes("*");
  const allowedOrigin = !origin
    ? "*"
    : allowAny || allowedOrigins.includes(origin)
      ? origin
      : "null";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-org-id, x-user-id",
    "Vary": "Origin",
  };
}

/** Write a JSON response with CORS headers. Falls back to 500 if `payload` can't serialise. */
export function sendJson(res: http.ServerResponse, payload: unknown, status = 200) {
  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch {
    body = JSON.stringify({ error: "Failed to serialize response" });
    status = 500;
  }
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...corsHeaders(res),
  });
  res.end(body);
}

/** Write one Server-Sent Events frame. Caller manages the stream lifecycle. */
export function sendEvent(res: http.ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Read + parse a JSON body. Rejects 413 (`HttpError`) when bytes exceed
 * `maxBytes`. Resolves `{}` for empty bodies.
 */
export async function readJson(req: http.IncomingMessage, maxBytes: number) {
  return new Promise<unknown>((resolve, reject) => {
    let body = "";
    let receivedBytes = 0;
    let rejected = false;

    req.on("data", chunk => {
      receivedBytes += chunk.length;

      if (receivedBytes > maxBytes) {
        rejected = true;
        reject(httpError(`Request body too large. Limit is ${maxBytes} bytes`, 413));
        req.destroy();
        return;
      }

      body += chunk;
    });
    req.on("error", reject);
    req.on("end", () => {
      if (rejected) return;
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(httpError("Invalid JSON body", 400));
      }
    });
  });
}

/**
 * Read the raw request body as a string (no JSON parse). Used by
 * webhook handlers that must HMAC-verify against the exact bytes the
 * sender signed — re-stringifying a parsed object does NOT round-trip
 * byte-identically across implementations (key ordering, whitespace,
 * unicode normalization). Enforces the same byte cap as `readJson`.
 *
 * Chunks are collected as Buffers and assembled with `Buffer.concat`
 * before a single `toString("utf8")` decode at the end — incremental
 * `body += chunk` would invoke the default decoder per chunk, which
 * (a) replaces invalid UTF-8 bytes with U+FFFD and (b) mis-decodes
 * multi-byte sequences split across a chunk boundary. Single-shot
 * decode avoids both pitfalls.
 */
export async function readRawBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let rejected = false;

    req.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        rejected = true;
        reject(httpError(`Request body too large. Limit is ${maxBytes} bytes`, 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (rejected) return;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

/** Narrow `unknown` to `Record<string, unknown>` (or `{}` on miss). Used for JSON-body destructuring. */
export function asRecord(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Narrow `unknown` to a finite `number` (or `undefined` on miss). */
export function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
