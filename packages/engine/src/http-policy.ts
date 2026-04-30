import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

const privateHostnames = new Set(["localhost", "localhost.localdomain"]);

function privateHttpTargetsAllowed() {
  return process.env.ALLOW_PRIVATE_HTTP_TARGETS === "true";
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

  const pinnedLookup: PinnedLookup = (_hostname, _options, callback) => {
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

export async function validateHttpTarget(rawUrl: unknown): Promise<string> {
  const { url } = await validateAndResolveTarget(rawUrl);
  return url;
}

export async function fetchHttpTarget(rawUrl: unknown, init?: RequestInit): Promise<Response> {
  const { url, agent } = await validateAndResolveTarget(rawUrl);
  if (!agent) {
    return fetch(url, init);
  }
  // undici.fetch's Response and the global Response are structurally identical
  // at the surface our callers consume (.status, .ok, .text(), .json()). The
  // `dispatcher` option is undici-specific and not on `lib.dom`'s RequestInit,
  // so we cast at the boundary; runtime behaviour is unchanged.
  return undiciFetch(url, { ...(init ?? {}), dispatcher: agent } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
}

// Internal-only handle for tests. Not part of the public surface; the name is
// the convention so `import { __testInternals } from "./http-policy"` is loud.
export const __testInternals = { resolveAndPin };
