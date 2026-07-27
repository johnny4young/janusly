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

export type ProviderSimulationReceipt = {
  kind: "provider_simulation_receipt";
  version: 1;
  provider: "webhook";
  operation: "deliver";
  scope: "validation" | "production";
  effectId: string;
  idempotencyKey: string | null;
  applied: boolean;
  duplicate: boolean;
  requestId: string;
};

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

export function isLocalIntegrationSimulatorEndpoint(value: string, path: string): boolean {
  const endpoint = localIntegrationSimulatorEndpoint(path);
  if (!endpoint) return false;
  try {
    const candidate = new URL(value);
    const expected = new URL(endpoint);
    return candidate.origin === expected.origin && candidate.pathname === expected.pathname;
  } catch {
    return false;
  }
}

export function parseProviderSimulationReceipt(
  value: unknown,
  expectedScope?: ProviderSimulationReceipt["scope"],
): ProviderSimulationReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  const scope = receipt.scope;
  const idempotencyKey = receipt.idempotencyKey;
  if (
    receipt.kind !== "provider_simulation_receipt"
    || receipt.version !== 1
    || receipt.provider !== "webhook"
    || receipt.operation !== "deliver"
    || (scope !== "validation" && scope !== "production")
    || (expectedScope !== undefined && scope !== expectedScope)
    || typeof receipt.effectId !== "string"
    || receipt.effectId.length === 0
    || (idempotencyKey !== null && (typeof idempotencyKey !== "string" || idempotencyKey.length === 0))
    || typeof receipt.applied !== "boolean"
    || typeof receipt.duplicate !== "boolean"
    || receipt.applied === receipt.duplicate
    || typeof receipt.requestId !== "string"
    || receipt.requestId.length === 0
  ) {
    return null;
  }
  return {
    kind: "provider_simulation_receipt",
    version: 1,
    provider: "webhook",
    operation: "deliver",
    scope,
    effectId: receipt.effectId,
    idempotencyKey,
    applied: receipt.applied,
    duplicate: receipt.duplicate,
    requestId: receipt.requestId,
  };
}

export function isLocalWebhookPlaceholder(value: string): boolean {
  try {
    const target = new URL(value);
    return (
      (target.protocol === "http:" || target.protocol === "https:")
      && !target.username
      && !target.password
      && target.hostname.endsWith(".example.com")
    );
  } catch {
    return false;
  }
}

export function resolveLocalWebhookDestination(value: string): string {
  const endpoint = localIntegrationSimulatorEndpoint("/webhook");
  if (!endpoint) return value;

  if (!isLocalWebhookPlaceholder(value)) return value;
  const target = new URL(value);
  const simulator = new URL(endpoint);
  simulator.searchParams.set("target", target.href);
  return simulator.href;
}
