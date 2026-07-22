/**
 * Explicit local-only routing for the bundled provider simulator.
 *
 * Used by:
 * - `integration-tools.ts` for GitHub, Slack, and reserved example webhooks.
 * - `mailer.ts` for local email delivery evidence.
 *
 * Invariants:
 * - Disabled unless `JANUSLY_LOCAL_INTEGRATION_SIMULATOR=true`.
 * - The base URL is process-owned configuration, never tenant configuration.
 * - Credentials, query strings, and fragments are rejected from the base URL.
 * - Arbitrary outbound URLs are never rewritten. Only the RFC-reserved
 *   `.example.com` pack placeholders may route to the simulator.
 */

const ENABLED_ENV = "JANUSLY_LOCAL_INTEGRATION_SIMULATOR";
const URL_ENV = "JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL";

export function getLocalIntegrationSimulatorUrl(): URL | null {
  if (process.env[ENABLED_ENV] !== "true") return null;

  const raw = process.env[URL_ENV]?.trim();
  if (!raw) throw new Error(`${URL_ENV} is required when ${ENABLED_ENV}=true`);

  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${URL_ENV} must use http or https`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${URL_ENV} must not contain credentials, a query, or a fragment`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url;
}

export function localIntegrationSimulatorEndpoint(path: string): string | null {
  const base = getLocalIntegrationSimulatorUrl();
  if (!base) return null;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const basePath = base.pathname === "/" ? "" : base.pathname;
  return `${base.origin}${basePath}${normalized}`;
}

export function isLocalSlackSimulatorUrl(value: string): boolean {
  const endpoint = localIntegrationSimulatorEndpoint("/slack/");
  if (!endpoint) return false;
  try {
    const candidate = new URL(value);
    return candidate.href.startsWith(endpoint);
  } catch {
    return false;
  }
}

export function resolveLocalWebhookDestination(value: string): string {
  const endpoint = localIntegrationSimulatorEndpoint("/webhook");
  if (!endpoint) return value;

  const target = new URL(value);
  if (!target.hostname.endsWith(".example.com")) return value;
  const simulator = new URL(endpoint);
  simulator.searchParams.set("target", target.href);
  return simulator.href;
}
