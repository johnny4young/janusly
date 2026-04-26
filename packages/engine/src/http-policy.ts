import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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

function isPrivateIPv6(address: string) {
  const value = address.toLowerCase();
  return value === "::1"
    || value.startsWith("fc")
    || value.startsWith("fd")
    || value.startsWith("fe80:")
    || value.startsWith("::ffff:127.")
    || value.startsWith("::ffff:10.")
    || value.startsWith("::ffff:192.168.");
}

function isPrivateAddress(address: string) {
  const normalized = normalizeHostname(address);
  const version = isIP(normalized);
  if (version === 4) return isPrivateIPv4(normalized);
  if (version === 6) return isPrivateIPv6(normalized);
  return false;
}

async function assertPublicHostname(hostname: string) {
  const normalized = normalizeHostname(hostname);

  if (privateHostnames.has(normalized) || normalized.endsWith(".localhost")) {
    throw new Error(`HTTP target is private and blocked: ${hostname}`);
  }

  if (isPrivateAddress(normalized)) {
    throw new Error(`HTTP target is private and blocked: ${hostname}`);
  }

  const addresses = await lookup(normalized, { all: true, verbatim: false });
  if (addresses.some(address => isPrivateAddress(address.address))) {
    throw new Error(`HTTP target resolves to a private address and is blocked: ${hostname}`);
  }
}

export async function validateHttpTarget(rawUrl: unknown) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new Error("HTTP target url is required");
  }

  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported HTTP target protocol: ${url.protocol}`);
  }

  if (!privateHttpTargetsAllowed()) {
    await assertPublicHostname(url.hostname);
  }

  return url.toString();
}

export async function fetchHttpTarget(rawUrl: unknown, init?: RequestInit) {
  const url = await validateHttpTarget(rawUrl);
  return fetch(url, init);
}
