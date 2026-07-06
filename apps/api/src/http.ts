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
import { gzipSync } from "node:zlib";
import { errorEnvelope, type ApiErrorCode } from "./error-codes";

/** `Error` carrying an HTTP status. `server.ts` reads `statusCode` to map throws to responses. */
export type HttpError = Error & { statusCode?: number };

/**
 * Responses below this many serialized bytes are sent uncompressed — gzip's
 * header + CPU overhead is not worth it for tiny payloads (and most of the
 * catalogued error envelopes are well under a KB).
 */
const GZIP_MIN_BYTES = 1024;

/** Compression is on by default; `JANUSLY_HTTP_COMPRESSION=false` is the kill-switch. */
function compressionEnabled(): boolean {
  return process.env.JANUSLY_HTTP_COMPRESSION !== "false";
}

/**
 * Whether the client's `Accept-Encoding` positively advertises gzip. A token
 * of `gzip;q=0` is an explicit refusal (RFC 9110 §12.5.3) and must NOT be
 * treated as acceptance. We only ever compress when the client opts in, so
 * clients that don't send the header (and can't decode gzip) are unaffected.
 */
function clientAcceptsGzip(header: string): boolean {
  for (const part of header.split(",")) {
    const [encoding, ...params] = part.trim().split(";");
    if (encoding.trim().toLowerCase() !== "gzip") continue;
    const qParam = params.map((p) => p.trim()).find((p) => p.toLowerCase().startsWith("q="));
    if (qParam) {
      const q = Number(qParam.slice(2));
      return Number.isFinite(q) && q > 0;
    }
    return true;
  }
  return false;
}

/**
 * gzip `body` when the request opted in and the payload is large enough,
 * else `null` (send uncompressed). Never throws — a compression failure
 * degrades to the plain body rather than dropping the response.
 */
function maybeGzip(res: http.ServerResponse, body: string): Buffer | null {
  if (!compressionEnabled()) return null;
  const acceptEncoding = (res as CorsAwareResponse).requestAcceptEncoding ?? "";
  if (!clientAcceptsGzip(acceptEncoding)) return null;
  if (Buffer.byteLength(body, "utf8") < GZIP_MIN_BYTES) return null;
  try {
    return gzipSync(body);
  } catch {
    return null;
  }
}

/** Build an `HttpError` with a fixed status. The route handler's catch maps it to the response. */
export function httpError(message: string, statusCode: number): HttpError {
  const err = new Error(message) as HttpError;
  err.statusCode = statusCode;
  return err;
}

const DEFAULT_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174";

/**
 * `ServerResponse` augmented with request context the dispatcher stashes on
 * it: `requestOrigin` (so `corsHeaders` can echo an allowlisted origin) and
 * `requestAcceptEncoding` (so `sendJson` can decide whether to gzip).
 */
export type CorsAwareResponse = http.ServerResponse & {
  requestOrigin?: string;
  requestAcceptEncoding?: string;
};

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
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-org-id, x-user-id, x-janusly-session, Accept-Language, Last-Event-ID",
    "Vary": "Origin",
  };
}

/**
 * Write a JSON response with CORS headers. Falls back to 500 if `payload`
 * can't serialise. Transparently gzip-compresses the body when the request
 * advertised `Accept-Encoding: gzip` and the payload clears `GZIP_MIN_BYTES`
 * — the single chokepoint every non-SSE route goes through, so compression is
 * uniform without per-route changes. SSE writers (`sendEventFrame`) bypass
 * this and stay uncompressed.
 */
export function sendJson(res: http.ServerResponse, payload: unknown, status = 200) {
  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch {
    body = JSON.stringify({ error: "Failed to serialize response" });
    status = 500;
  }
  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": "application/json",
    ...corsHeaders(res),
  };
  const compressed = maybeGzip(res, body);
  if (compressed) {
    headers["Content-Encoding"] = "gzip";
    // Preserve the `Vary: Origin` corsHeaders already set — caches must key
    // on BOTH the origin and the accepted encoding.
    headers["Vary"] = [headers["Vary"], "Accept-Encoding"].filter(Boolean).join(", ");
    res.writeHead(status, headers);
    res.end(compressed);
    return;
  }
  res.writeHead(status, headers);
  res.end(body);
}

/**
 * Canonical 4xx/5xx error responder: the single chokepoint that ships the
 * `{ error, code, params? }` envelope the web localizes against. Thin sugar
 * over `sendJson(res, errorEnvelope(code, message, params), status)` — use
 * this for every catalogued error response so the `code` field is uniformly
 * present. `status` defaults to 400 (the most common client-error case).
 */
export function sendError(
  res: http.ServerResponse,
  code: ApiErrorCode,
  message: string,
  status = 400,
  params?: Record<string, string | number | boolean>,
) {
  return sendJson(res, errorEnvelope(code, message, params), status);
}

/**
 * Write one Server-Sent Events frame. Caller manages the stream lifecycle.
 * An `id` (when provided) becomes the SSE `id:` line — the client echoes it
 * as `Last-Event-ID` on reconnect so the server can replay the gap. `event`
 * sets the named SSE event type. `data` is JSON-encoded. Lines that could
 * contain a newline are written field-by-field per the SSE wire format.
 */
export function sendEventFrame(
  res: http.ServerResponse,
  frame: { id?: string; event?: string; data: unknown },
) {
  let out = "";
  if (frame.id !== undefined) out += `id: ${frame.id}\n`;
  if (frame.event !== undefined) out += `event: ${frame.event}\n`;
  out += `data: ${JSON.stringify(frame.data)}\n\n`;
  res.write(out);
}

/** Write a bare SSE comment line (`: text`). Used for keep-alive heartbeats. */
export function sendSseComment(res: http.ServerResponse, text: string) {
  res.write(`: ${text}\n\n`);
}

/**
 * Read + parse a JSON body. Rejects 413 (`HttpError`) when bytes exceed
 * `maxBytes`. Resolves `{}` for empty bodies.
 *
 * Chunks are collected as Buffers and decoded once with `Buffer.concat`
 * at the end — the same single-shot decode `readRawBody` uses. Incremental
 * `body += chunk` would decode each chunk independently, mis-decoding any
 * multi-byte UTF-8 character split across a chunk boundary into U+FFFD.
 * Because U+FFFD is a valid character inside a JSON string, that corruption
 * is SILENT: the body still parses and the mangled text gets persisted.
 */
export async function readJson(req: http.IncomingMessage, maxBytes: number) {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let rejected = false;

    req.on("data", (chunk: Buffer | string) => {
      // Real `IncomingMessage` streams emit Buffers (nothing in the API calls
      // `setEncoding`), but normalize defensively so a string chunk (an
      // encoding-set stream or a test double) can't break the single-shot
      // decode below — and so the byte cap counts real UTF-8 bytes rather
      // than UTF-16 code units.
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      receivedBytes += bytes.length;

      if (receivedBytes > maxBytes) {
        rejected = true;
        reject(httpError(`Request body too large. Limit is ${maxBytes} bytes`, 413));
        req.destroy();
        return;
      }

      chunks.push(bytes);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (rejected) return;
      const body = Buffer.concat(chunks).toString("utf8");
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
