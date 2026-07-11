/** Pure configuration helpers for the root development orchestrator. */

import { isIP } from "node:net";

export const DEFAULT_DEV_HOST = "127.0.0.1";
export const DEV_WEB_PORT = 5173;

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;

/** Resolve the Vite bind host without accepting URLs, paths, or shell-like whitespace. */
export function resolveDevHost(rawHost) {
  if (rawHost === undefined || rawHost === null || rawHost === "") return DEFAULT_DEV_HOST;
  if (rawHost !== rawHost.trim() || /\s/.test(rawHost) || rawHost.includes("/") || rawHost.includes("://")) {
    throw new Error("JANUSLY_DEV_HOST must be a hostname or IP address, not a URL or path");
  }
  if (isIP(rawHost) !== 0 || HOSTNAME_PATTERN.test(rawHost)) return rawHost;
  throw new Error(`Invalid JANUSLY_DEV_HOST: ${rawHost}`);
}

/** Return a browser-reachable URL even when Vite deliberately binds a wildcard address. */
export function devWebUrl(host) {
  const reachableHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const urlHost = isIP(reachableHost) === 6 ? `[${reachableHost}]` : reachableHost;
  return `http://${urlHost}:${DEV_WEB_PORT}`;
}

export function viteArgs(host) {
  return ["--host", host, "--port", String(DEV_WEB_PORT), "--strictPort"];
}
