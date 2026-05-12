/**
 * SSRF + DNS-rebinding pin AND bound outbound execution. Resolves the
 * hostname once, validates every returned address against the private-IP
 * block list, constructs an `undici.Agent` whose `connect.lookup` returns
 * the pinned IP, and wraps the fetch with three runtime bounds:
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

/** Already-consumed result of `fetchHttpTarget`. The body has been read, capped, and decoded — callers can't sidestep the byte cap. */
export type HttpResult = {
  statusCode: number;
  ok: boolean;
  body: string;
  headers: Record<string, string>;
};

/** RequestInit + the three optional override fields. Pass these alongside any standard fetch options. */
export type HttpFetchInit = RequestInit & {
  /** Total timeout budget across all redirect hops, in ms. Default 30000 (env `JANUSLY_HTTP_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Maximum decoded response body size, in bytes. Default 1_000_000 (env `JANUSLY_HTTP_MAX_RESPONSE_BYTES`). */
  maxResponseBytes?: number;
  /** Maximum redirect chain length. Default 5 (env `JANUSLY_HTTP_MAX_REDIRECTS`). */
  maxRedirects?: number;
};

function splitInit(init: HttpFetchInit | undefined): {
  requestInit: RequestInit | undefined;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
} {
  if (!init) {
    return {
      requestInit: undefined,
      timeoutMs: defaultTimeoutMs(),
      maxBytes: defaultMaxResponseBytes(),
      maxRedirects: defaultMaxRedirects(),
    };
  }
  const { timeoutMs, maxResponseBytes, maxRedirects, ...rest } = init;
  const timeoutDefault = defaultTimeoutMs();
  const maxBytesDefault = defaultMaxResponseBytes();
  const maxRedirectsDefault = defaultMaxRedirects();
  return {
    requestInit: rest as RequestInit,
    timeoutMs: positiveIntOrFallback(timeoutMs, timeoutDefault),
    maxBytes: positiveIntOrFallback(maxResponseBytes, maxBytesDefault),
    maxRedirects: nonNegativeIntOrFallback(maxRedirects, maxRedirectsDefault),
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
  const declared = res.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      controller.abort();
      throw new Error(`HTTP response exceeds maxResponseBytes (Content-Length ${n} > cap ${maxBytes})`);
    }
  }

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
 * One redirect hop. Recurses on 3xx, revalidating the next URL through the
 * same SSRF pin. Shares the AbortController across recursion so the total
 * timeout is a single budget — not per-hop.
 */
async function fetchOneHop(
  rawUrl: unknown,
  requestInit: RequestInit | undefined,
  controller: AbortController,
  maxBytes: number,
  redirectsRemaining: number,
): Promise<HttpResult> {
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
      // 3xx without Location is a malformed response — surface as-is.
      return { statusCode: res.status, ok: res.ok, body: "", headers: headersToRecord(res.headers) };
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

    return fetchOneHop(nextUrl, nextInit, controller, maxBytes, redirectsRemaining - 1);
  }

  const body = await readBoundedBody(res, maxBytes, controller);
  return { statusCode: res.status, ok: res.ok, body, headers: headersToRecord(res.headers) };
}

/**
 * Validated, bounded `fetch` for outbound HTTP. Resolves DNS once, pins the
 * IP to the connect path, applies the timeout / body-cap / redirect-limit
 * bounds, and returns a fully-consumed `HttpResult`. The single chokepoint
 * for `http` node + `http.request` tool — direct `fetch` calls bypass all
 * of this and must not be reintroduced.
 */
export async function fetchHttpTarget(rawUrl: unknown, init?: HttpFetchInit): Promise<HttpResult> {
  const { requestInit, timeoutMs, maxBytes, maxRedirects } = splitInit(init);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchOneHop(rawUrl, requestInit, controller, maxBytes, maxRedirects);
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
