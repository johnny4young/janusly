/**
 * SSRF + DNS-rebinding pin AND bound outbound execution. Resolves the
 * hostname once, validates every returned address against the private-IP
 * block list, constructs an `undici.Agent` whose `connect.lookup` returns
 * the pinned IP, and wraps the fetch with three runtime bounds:
 *
 * Two body-handling modes:
 *   - **`bodyMode: "buffer"` (default)** — `HttpBufferedResult` with the
 *     decoded body as a `string`, fully consumed and capped.
 *   - **`bodyMode: "stream"` (opt-in)** — `HttpStreamingResult` with the
 *     body as a `ReadableStream<Uint8Array>` the caller iterates
 *     chunk-by-chunk. The same byte cap applies; the stream aborts the
 *     shared AbortController the instant total bytes exceed the cap and
 *     surfaces the same descriptive error the buffered path emits. Streams
 *     MUST be consumed within the same executor invocation — they cannot
 *     survive `safePersistPayload`. Use `consumeStreamToPreview` for an
 *     audit-friendly bounded slice before persistence.
 *
 *   - **Timeout** (default 30s, env `JANUSLY_HTTP_TIMEOUT_MS`, per-call
 *     override `init.timeoutMs`): single AbortController + `setTimeout`
 *     budget across all redirect hops. Without this, Node's `fetch` never
 *     times out — one hung upstream wedges a worker until the OS kills the
 *     TCP connection.
 *   - **Body cap** (default 1 MB, env `JANUSLY_HTTP_MAX_RESPONSE_BYTES`,
 *     per-call override `init.maxResponseBytes`): streaming reader with a
 *     byte counter; aborts mid-stream when total exceeds the cap, plus a
 *     Content-Length pre-check so oversized declared bodies are rejected
 *     before consuming. Prevents OOM on a 10 GB body and prevents
 *     `run_nodes.state_json.output.body` from silently inflating.
 *   - **Manual redirect handling** (default 5 hops, env
 *     `JANUSLY_HTTP_MAX_REDIRECTS`, per-call override `init.maxRedirects`):
 *     each redirect's Location is re-resolved through the same SSRF pin,
 *     so a 302 to e.g. `169.254.169.254` (AWS metadata) is rejected at the
 *     second resolve. Default browser behaviour (`redirect: "follow"`) is
 *     the bypass route the existing pin doesn't catch.
 *
 * Returns `HttpResult` (already-consumed body) instead of a half-read
 * `Response` so the bounds can't be sidestepped by a caller that asks for
 * `.body` directly. The two callers (`http` node + `http.request` tool)
 * each only consume `statusCode` / `ok` / `body` / `headers`.
 *
 * Used by `node-registry.ts` (`http` node executor) and `tool-registry.ts`
 * (`http.request` tool). Both must go through `fetchHttpTarget` — direct
 * `fetch` / `undici.fetch` calls reopen the DNS-rebinding TOCTOU and skip
 * the bounds entirely.
 *
 * Invariants:
 * - Don't unwind the pinned dispatcher path. Calling `undici.fetch` without
 *   the pinned `Agent` would reopen the DNS rebinding window.
 * - `ALLOW_PRIVATE_HTTP_TARGETS=true` is the explicit env-flag bypass for
 *   local-development hosts; never default to true.
 * - Bounds are default-on. Workflows that legitimately need higher caps
 *   opt in per call (`timeoutMs` / `maxResponseBytes` / `maxRedirects`).
 *   The chokepoint must never expose an "unbounded" mode.
 * - Redirect revalidation is unconditional — it goes through the same
 *   `validateAndResolveTarget` as the initial hop, no shortcut.
 * - Block list covers loopback (127/8, ::1), link-local (169.254/16,
 *   fe80::/10), private RFC 1918 ranges, AWS metadata (`169.254.169.254`),
 *   carrier-grade NAT, and IPv4-mapped IPv6 forms.
 */

import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

const privateHostnames = new Set(["localhost", "localhost.localdomain"]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_MAX_REDIRECTS = 5;

function privateHttpTargetsAllowed() {
  return process.env.ALLOW_PRIVATE_HTTP_TARGETS === "true";
}

function envPositiveInt(key: string, fallback: number) {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return positiveIntOrFallback(n, fallback);
}

function positiveIntOrFallback(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function nonNegativeIntOrFallback(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function defaultTimeoutMs() {
  return envPositiveInt("JANUSLY_HTTP_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}
function defaultMaxResponseBytes() {
  return envPositiveInt("JANUSLY_HTTP_MAX_RESPONSE_BYTES", DEFAULT_MAX_RESPONSE_BYTES);
}
function defaultMaxRedirects() {
  return envPositiveInt("JANUSLY_HTTP_MAX_REDIRECTS", DEFAULT_MAX_REDIRECTS);
}

function normalizeHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function isPrivateIPv4(address: string) {
  const parts = address.split(".").map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => Number.isNaN(part) || part < 0 || part > 255)) return false;

  const [first, second] = parts;
  if (first === 0 || first === 10 || first === 127) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  return first >= 224;
}

function ipv4FromMappedIPv6(address: string) {
  const value = address.toLowerCase();
  const prefix = value.startsWith("::ffff:")
    ? "::ffff:"
    : value.startsWith("0:0:0:0:0:ffff:")
      ? "0:0:0:0:0:ffff:"
      : null;
  if (!prefix) return null;

  const suffix = value.slice(prefix.length);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(suffix)) return suffix;

  const hextets = suffix.split(":");
  if (hextets.length !== 2 || hextets.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;

  const high = Number.parseInt(hextets[0]!, 16);
  const low = Number.parseInt(hextets[1]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isPrivateIPv6(address: string) {
  const value = address.toLowerCase();
  const mappedIPv4 = ipv4FromMappedIPv6(value);
  if (mappedIPv4) return isPrivateIPv4(mappedIPv4);

  return value === "::1"
    || value === "::"
    || value.startsWith("fc")
    || value.startsWith("fd")
    || value.startsWith("fe80:")
    || value.startsWith("ff");
}

function isPrivateAddress(address: string) {
  const normalized = normalizeHostname(address);
  const version = isIP(normalized);
  if (version === 4) return isPrivateIPv4(normalized);
  if (version === 6) return isPrivateIPv6(normalized);
  return false;
}

type ResolvedAddress = { address: string; family: 4 | 6 };
// Use Node's LookupFunction type (the same shape undici's `connect.lookup`
// accepts). Keeping the type imported keeps the pinned closure typed end to end.
type PinnedLookup = LookupFunction;

/**
 * Resolve a hostname, assert every returned address is public, and produce a
 * pinned `lookup` callback (and an `undici.Agent` that uses it) so that the
 * subsequent TCP connect uses the address we just validated — closing the
 * DNS-rebinding TOCTOU between validation and the actual fetch.
 */
async function resolveAndPin(hostname: string): Promise<{
  addresses: ResolvedAddress[];
  pinnedLookup: PinnedLookup;
  agent: Agent;
}> {
  const normalized = normalizeHostname(hostname);

  if (privateHostnames.has(normalized) || normalized.endsWith(".localhost")) {
    throw new Error(`HTTP target is private and blocked: ${hostname}`);
  }

  if (isPrivateAddress(normalized)) {
    throw new Error(`HTTP target is private and blocked: ${hostname}`);
  }

  const addresses = (await lookup(normalized, { all: true, verbatim: false })) as ResolvedAddress[];
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error(`HTTP target resolves to a private address and is blocked: ${hostname}`);
  }
  if (addresses.length === 0) {
    throw new Error(`HTTP target did not resolve to any address: ${hostname}`);
  }

  // Pin to the first validated address. The pinned lookup ignores its
  // `hostname` argument and always returns this exact address — undici will
  // hand it to the connect step without ever consulting DNS again.
  const pinned = addresses[0];

  const pinnedLookup: PinnedLookup = (_hostname, options, callback) => {
    if (isPrivateAddress(pinned.address)) {
      // Defence in depth: should never trip given the assertion above, but
      // if a future change widens the public-IP check, the connect still
      // refuses to dial a private IP.
      const err = new Error(
        `Pinned HTTP target IP is private and blocked: ${pinned.address}`,
      ) as NodeJS.ErrnoException;
      callback(err, "", pinned.family);
      return;
    }
    // Node's dns.lookup callback contract: when `options.all === true`, the
    // callback receives `(err, addresses: { address, family }[])`; otherwise
    // it receives `(err, address: string, family: number)`. Undici 8.x calls
    // this hook with `{ all: true }`, so the scalar form fed back an
    // `address` string undici then tried to treat as an array, surfacing as
    // `Invalid IP address: undefined`. Honor both shapes explicitly.
    if ((options as { all?: boolean } | undefined)?.all) {
      // LookupFunction's narrow scalar callback signature doesn't expose
      // the array overload, but Node's net.LookupFunction accepts it and
      // undici relies on it. Cast to a permissive variant for the call —
      // the runtime contract is what undici inspects.
      (callback as unknown as (err: NodeJS.ErrnoException | null, addresses: { address: string; family: 4 | 6 }[]) => void)(
        null,
        [{ address: pinned.address, family: pinned.family }],
      );
      return;
    }
    callback(null, pinned.address, pinned.family);
  };

  // Per-request Agent (one fetch worth of work) — disable keep-alive so the
  // socket closes as soon as the request body finishes, freeing the FD before
  // GC. Without this the default 4s keepAliveTimeout leaks sockets under
  // sustained `http` node throughput.
  const agent = new Agent({
    connect: { lookup: pinnedLookup },
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
  });

  return { addresses, pinnedLookup, agent };
}

async function validateAndResolveTarget(rawUrl: unknown): Promise<{ url: string; agent?: Agent }> {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new Error("HTTP target url is required");
  }

  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported HTTP target protocol: ${url.protocol}`);
  }

  if (privateHttpTargetsAllowed()) {
    return { url: url.toString() };
  }

  const { agent } = await resolveAndPin(url.hostname);
  return { url: url.toString(), agent };
}

/**
 * Validate a URL: ensure scheme is http/https, hostname resolves to public
 * IPs (unless `ALLOW_PRIVATE_HTTP_TARGETS=true`), and return the normalised
 * URL string. Throws on any rejection so callers can surface a 400/403.
 */
export async function validateHttpTarget(rawUrl: unknown): Promise<string> {
  const { url } = await validateAndResolveTarget(rawUrl);
  return url;
}

/** Already-consumed result of `fetchHttpTarget` in the default `bodyMode: "buffer"` path. The body has been read, capped, and decoded — callers can't sidestep the byte cap. */
export type HttpBufferedResult = {
  statusCode: number;
  ok: boolean;
  body: string;
  headers: Record<string, string>;
};

/**
 * Live-stream result of `fetchHttpTarget` in opt-in `bodyMode: "stream"`. The
 * `body` is a `ReadableStream<Uint8Array>` the caller iterates chunk-by-chunk
 * without buffering the full payload in memory. The byte cap still applies —
 * the underlying stream aborts the shared `AbortController` the instant total
 * bytes exceed `maxResponseBytes`, and any pending `read()` rejects with the
 * same descriptive error message the buffered path emits.
 *
 * Streams are one-shot in JS and cannot be persisted to jsonb directly — the
 * caller MUST consume the stream within the same executor invocation (e.g.
 * via `consumeStreamToPreview` for an audit-friendly bounded slice). The
 * `safePersistPayload` chokepoint substitutes a placeholder if a `ReadableStream`
 * accidentally leaks through, but that's defense-in-depth; relying on it
 * loses the actual response data.
 */
export type HttpStreamingResult = {
  statusCode: number;
  ok: boolean;
  body: ReadableStream<Uint8Array>;
  headers: Record<string, string>;
};

/**
 * Union of buffered + streaming results. Each call narrows to one side via
 * the `fetchHttpTarget` overloads — callers that omit `bodyMode` (the
 * default `"buffer"`) get `HttpBufferedResult` and never have to check for
 * `ReadableStream`. Kept as the existing exported `HttpResult` name so all
 * pre-stream call sites continue to compile unchanged.
 */
export type HttpResult = HttpBufferedResult;

/** Opt-in body-handling mode for `fetchHttpTarget`. `"buffer"` (default) returns the decoded body as a string; `"stream"` returns a `ReadableStream<Uint8Array>` the caller iterates. */
export type HttpBodyMode = "buffer" | "stream";

/** RequestInit + the three optional override fields plus the body-mode discriminator. Pass these alongside any standard fetch options. */
export type HttpFetchInit = RequestInit & {
  /** Total timeout budget across all redirect hops, in ms. Default 30000 (env `JANUSLY_HTTP_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Maximum decoded response body size, in bytes. Default 1_000_000 (env `JANUSLY_HTTP_MAX_RESPONSE_BYTES`). Applies in BOTH buffer and stream modes — the streaming path aborts mid-flight at the cap, identical to the buffered path. */
  maxResponseBytes?: number;
  /** Maximum redirect chain length. Default 5 (env `JANUSLY_HTTP_MAX_REDIRECTS`). */
  maxRedirects?: number;
  /** Body handling. `"buffer"` (default) buffers the body into a `string`; `"stream"` returns a `ReadableStream<Uint8Array>` the caller MUST consume within the same executor invocation. */
  bodyMode?: HttpBodyMode;
};

function splitInit(init: HttpFetchInit | undefined): {
  requestInit: RequestInit | undefined;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  bodyMode: HttpBodyMode;
} {
  if (!init) {
    return {
      requestInit: undefined,
      timeoutMs: defaultTimeoutMs(),
      maxBytes: defaultMaxResponseBytes(),
      maxRedirects: defaultMaxRedirects(),
      bodyMode: "buffer",
    };
  }
  const { timeoutMs, maxResponseBytes, maxRedirects, bodyMode, ...rest } = init;
  const timeoutDefault = defaultTimeoutMs();
  const maxBytesDefault = defaultMaxResponseBytes();
  const maxRedirectsDefault = defaultMaxRedirects();
  return {
    requestInit: rest as RequestInit,
    timeoutMs: positiveIntOrFallback(timeoutMs, timeoutDefault),
    maxBytes: positiveIntOrFallback(maxResponseBytes, maxBytesDefault),
    maxRedirects: nonNegativeIntOrFallback(maxRedirects, maxRedirectsDefault),
    bodyMode: bodyMode === "stream" ? "stream" : "buffer",
  };
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Pre-check the Content-Length header against the byte cap. Returns the
 * declared length when it's present and under the cap; throws + aborts when
 * the upstream declared an oversized body, saving the round-trip before any
 * payload is consumed. Returns `null` when the header is absent (chunked
 * transfer-encoding) — the streaming counter catches the cap mid-stream
 * either way.
 */
function preflightContentLength(
  res: Response,
  maxBytes: number,
  controller: AbortController,
): number | null {
  const declared = res.headers.get("content-length");
  if (declared === null) return null;
  const n = Number(declared);
  if (!Number.isFinite(n)) return null;
  if (n > maxBytes) {
    controller.abort();
    throw new Error(`HTTP response exceeds maxResponseBytes (Content-Length ${n} > cap ${maxBytes})`);
  }
  return n;
}

/**
 * Stream the response body into memory, aborting if total bytes exceed the
 * cap. A Content-Length pre-check rejects oversized declared bodies before
 * the stream starts, saving the round-trip when the upstream is honest about
 * size. Otherwise the running counter catches malicious infinite streams.
 */
async function readBoundedBody(
  res: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<string> {
  preflightContentLength(res, maxBytes, controller);

  const reader = res.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      controller.abort();
      throw new Error(`HTTP response exceeds maxResponseBytes after ${total} bytes (cap ${maxBytes})`);
    }
    chunks.push(value);
  }

  return new TextDecoder("utf-8").decode(concatBytes(chunks, total));
}

/**
 * Wrap the upstream response body in a `ReadableStream<Uint8Array>` that
 * tracks running byte count and aborts the shared `AbortController` the
 * instant the total exceeds `maxBytes`. The pattern mirrors `readBoundedBody`
 * exactly — same cap, same error message, same `controller.abort()` trigger —
 * so the buffered and streaming paths are observationally identical from a
 * safety standpoint. Any pending reader on the returned stream surfaces the
 * cap-exceeded error the same way the buffered path's `throw` does.
 *
 * Returns an empty stream if the upstream provided no body (e.g. a 204 No
 * Content). The Content-Length pre-check already fired before this is
 * reached, so an oversized declared body has rejected upstream.
 */
function streamBoundedBody(
  res: Response,
  maxBytes: number,
  controller: AbortController,
): ReadableStream<Uint8Array> {
  const upstream = res.body;
  if (!upstream) {
    return new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.close();
      },
    });
  }

  let total = 0;
  const reader = upstream.getReader();
  let released = false;
  const releaseReader = () => {
    if (released) return;
    released = true;
    try { reader.releaseLock(); } catch { /* best effort */ }
  };

  return new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          releaseReader();
          streamController.close();
          return;
        }
        if (!value) return;
        total += value.byteLength;
        if (total > maxBytes) {
          // Cap exceeded — abort the shared controller so the underlying
          // socket closes immediately, and surface the same error string
          // the buffered path uses so test assertions and DLQ rows match.
          controller.abort();
          const err = new Error(`HTTP response exceeds maxResponseBytes after ${total} bytes (cap ${maxBytes})`);
          streamController.error(err);
          releaseReader();
          return;
        }
        streamController.enqueue(value);
      } catch (err) {
        // Reader throws (e.g. AbortError on timeout) — propagate to the
        // stream's consumer instead of silently closing.
        releaseReader();
        streamController.error(err);
      }
    },
    cancel(reason) {
      // Caller stopped consuming early — release the upstream reader and
      // abort the shared controller so the socket isn't left dangling.
      try { void reader.cancel(reason).catch(() => undefined).finally(releaseReader); } catch { releaseReader(); }
      controller.abort();
    },
  });
}

/**
 * Read up to `previewBytes` from a `ReadableStream<Uint8Array>` and return a
 * UTF-8 decoded preview plus the original byte count consumed. Helper for
 * persistence wrappers — the streaming-mode HTTP node executor calls this
 * before returning so the persisted `output.body` is a bounded preview the
 * operator can audit, instead of a `ReadableStream` that can't survive jsonb.
 *
 * The stream is consumed in full (or until `previewBytes` is reached AND any
 * remaining chunks are drained) — that way the byte-cap abort fires for the
 * full response even when the operator only persists a small preview. If
 * the underlying stream aborts mid-flight (cap exceeded), the helper rethrows
 * the same descriptive error the buffered path emits.
 *
 * Pure helper — does not access the network or the AbortController directly;
 * relies on the stream's own error propagation from `streamBoundedBody`.
 */
export async function consumeStreamToPreview(
  stream: ReadableStream<Uint8Array>,
  previewBytes: number,
): Promise<{ preview: string; originalBytes: number; truncated: boolean }> {
  const cap = positiveIntOrFallback(previewBytes, 65_536);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let previewCollected = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (previewCollected < cap) {
        const remaining = cap - previewCollected;
        if (value.byteLength <= remaining) {
          chunks.push(value);
          previewCollected += value.byteLength;
        } else {
          chunks.push(value.subarray(0, remaining));
          previewCollected += remaining;
          truncated = true;
        }
      } else {
        // Past the preview cap — keep counting bytes so the upstream
        // byte-cap abort still has a chance to fire, but stop buffering.
        truncated = true;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* best effort */ }
  }

  return {
    preview: new TextDecoder("utf-8").decode(concatBytes(chunks, previewCollected)),
    originalBytes: total,
    truncated,
  };
}

/**
 * Keep the total request timeout alive until the caller finishes consuming a
 * streamed body, without teeing and eagerly draining a second branch. A tee'd
 * timer branch would make the unread caller branch buffer the full response in
 * memory, defeating the streaming contract.
 */
function wrapStreamingBodyWithTimeoutCleanup(
  stream: ReadableStream<Uint8Array>,
  controller: AbortController,
  timer: ReturnType<typeof setTimeout>,
  timeoutMs: number,
  didTimeout: () => boolean,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let finalized = false;

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    clearTimeout(timer);
    try { reader.releaseLock(); } catch { /* best effort */ }
  };

  return new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finalize();
          streamController.close();
          return;
        }
        if (value) streamController.enqueue(value);
      } catch (err) {
        finalize();
        streamController.error(
          didTimeout()
            ? new Error(`HTTP request timed out after ${timeoutMs}ms`)
            : err,
        );
      }
    },
    cancel(reason) {
      const finish = () => {
        controller.abort();
        finalize();
      };
      try {
        return reader.cancel(reason).catch(() => undefined).finally(finish);
      } catch {
        finish();
        return undefined;
      }
    },
  });
}

/**
 * One redirect hop. Recurses on 3xx, revalidating the next URL through the
 * same SSRF pin. Shares the AbortController across recursion so the total
 * timeout is a single budget — not per-hop. The `bodyMode` parameter only
 * affects how the terminal (non-3xx) hop's body is shaped — redirect hops
 * always drain + close, regardless of mode.
 */
async function fetchOneHop(
  rawUrl: unknown,
  requestInit: RequestInit | undefined,
  controller: AbortController,
  maxBytes: number,
  redirectsRemaining: number,
  bodyMode: HttpBodyMode,
): Promise<HttpBufferedResult | HttpStreamingResult> {
  const { url, agent } = await validateAndResolveTarget(rawUrl);

  const baseInit: RequestInit = {
    ...(requestInit ?? {}),
    signal: controller.signal,
    redirect: "manual",
  };

  const res = agent
    ? (await undiciFetch(url, { ...baseInit, dispatcher: agent } as Parameters<typeof undiciFetch>[1])) as unknown as Response
    : await fetch(url, baseInit);

  if (REDIRECT_STATUSES.has(res.status)) {
    // Drain the redirect response body before recursing — undici's
    // keep-alive=1 closes the socket anyway, but cancelling is explicit and
    // releases internal buffers immediately.
    try { await res.body?.cancel(); } catch { /* best-effort */ }

    const location = res.headers.get("location");
    if (!location) {
      // 3xx without Location is a malformed response — surface as-is. In
      // streaming mode we still return an empty stream so the discriminator
      // type stays sound (the caller can `.getReader()` and read EOF).
      const headers = headersToRecord(res.headers);
      if (bodyMode === "stream") {
        return {
          statusCode: res.status,
          ok: res.ok,
          body: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
          headers,
        };
      }
      return { statusCode: res.status, ok: res.ok, body: "", headers };
    }
    if (redirectsRemaining <= 0) {
      throw new Error(`HTTP redirect limit exceeded; last hop ${url} -> ${location}`);
    }

    const nextUrl = new URL(location, url).toString();
    // Per HTTP spec: 301/302/303 coerce method to GET and drop the body for
    // historical browser-compat reasons; 307/308 preserve method + body.
    let nextInit: RequestInit | undefined = requestInit;
    if (res.status === 301 || res.status === 302 || res.status === 303) {
      nextInit = { ...(requestInit ?? {}), method: "GET", body: undefined };
    }

    return fetchOneHop(nextUrl, nextInit, controller, maxBytes, redirectsRemaining - 1, bodyMode);
  }

  const headers = headersToRecord(res.headers);
  if (bodyMode === "stream") {
    // Pre-check Content-Length BEFORE handing the stream to the caller so
    // an upstream that lies about size large rejects on the first byte
    // (matches the buffered path's `readBoundedBody` precheck shape).
    preflightContentLength(res, maxBytes, controller);
    return {
      statusCode: res.status,
      ok: res.ok,
      body: streamBoundedBody(res, maxBytes, controller),
      headers,
    };
  }
  const body = await readBoundedBody(res, maxBytes, controller);
  return { statusCode: res.status, ok: res.ok, body, headers };
}

/**
 * Validated, bounded `fetch` for outbound HTTP. Resolves DNS once, pins the
 * IP to the connect path, applies the timeout / body-cap / redirect-limit
 * bounds, and returns either a fully-consumed `HttpBufferedResult` (default)
 * or an `HttpStreamingResult` whose `body` is a `ReadableStream<Uint8Array>`
 * the caller iterates chunk-by-chunk. The single chokepoint for `http` node
 * + `http.request` tool — direct `fetch` calls bypass all of this and must
 * not be reintroduced.
 *
 * Streaming mode does NOT loosen the byte cap — the returned stream aborts
 * the same shared `AbortController` and surfaces the same descriptive error
 * the moment total bytes exceed `maxResponseBytes`. Callers MUST consume the
 * stream within the same executor invocation; streams cannot survive
 * `safePersistPayload` (the chokepoint substitutes a placeholder if one
 * leaks through).
 */
// Overload order matters for tooling, not for call-site resolution. TS
// picks the first matching overload at the call site — both signatures
// here are mutually exclusive on the literal `bodyMode` discriminant, so
// a caller's narrowed return type is determined by what they pass.
// However, tools like vitest's `vi.mocked()` rely on `ReturnType<typeof
// fetchHttpTarget>`, which resolves to the LAST overload's return type
// — so the buffered signature is last to keep `vi.mocked(fetchHttpTarget)
// .mockResolvedValueOnce({ body: "...", ... })` working without explicit
// casts in every pre-existing test that doesn't care about streams.
export function fetchHttpTarget(
  rawUrl: unknown,
  init: HttpFetchInit & { bodyMode: "stream" },
): Promise<HttpStreamingResult>;
export function fetchHttpTarget(
  rawUrl: unknown,
  init?: HttpFetchInit & { bodyMode?: "buffer" | undefined },
): Promise<HttpBufferedResult>;
export async function fetchHttpTarget(
  rawUrl: unknown,
  init?: HttpFetchInit,
): Promise<HttpBufferedResult | HttpStreamingResult> {
  const { requestInit, timeoutMs, maxBytes, maxRedirects, bodyMode } = splitInit(init);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // In streaming mode the timer must outlive `fetchOneHop`'s return — the
  // caller still has to read the body, and a hung mid-stream upstream
  // should still trip the timeout. Cleanup is attached to the caller's stream
  // consumption path; the buffered path keeps the existing finally block.
  if (bodyMode === "stream") {
    try {
      const result = await fetchOneHop(rawUrl, requestInit, controller, maxBytes, maxRedirects, "stream");
      // Type narrows via the bodyMode switch.
      const streaming = result as HttpStreamingResult;
      return {
        ...streaming,
        body: wrapStreamingBodyWithTimeoutCleanup(
          streaming.body,
          controller,
          timer,
          timeoutMs,
          () => timedOut,
        ),
      };
    } catch (err) {
      clearTimeout(timer);
      if (timedOut) {
        throw new Error(`HTTP request timed out after ${timeoutMs}ms`);
      }
      throw err;
    }
  }

  try {
    return await fetchOneHop(rawUrl, requestInit, controller, maxBytes, maxRedirects, "buffer");
  } catch (err) {
    if (timedOut) {
      throw new Error(`HTTP request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Internal-only handle for tests. Not part of the public surface; the name is
// the convention so `import { __testInternals } from "./http-policy"` is loud.
/** Test-only escape: surfaces the internal `resolveAndPin` so DNS-rebinding regression tests can drive it. Production code must never call this. */
export const __testInternals = { resolveAndPin };
