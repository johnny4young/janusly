import {
  getLocalIntegrationSimulatorUrl,
  isLocalIntegrationSimulatorEndpoint,
  isLocalWebhookPlaceholder,
  resolveLocalWebhookDestination,
} from "./local-integration-simulator";

function idempotencyHeader(input: Record<string, unknown>): string | null {
  const headers = input.headers;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "x-idempotency-key") continue;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }
  return null;
}

export function isProviderSimulationRuntimeAvailable(): boolean {
  if (
    process.env.JANUSLY_LOCAL_STACK !== "true"
    || process.env.JANUSLY_LOCAL_INTEGRATION_SIMULATOR !== "true"
  ) {
    return false;
  }
  try {
    return getLocalIntegrationSimulatorUrl() !== null;
  } catch {
    return false;
  }
}

/**
 * The only write-side invocation allowed to cross a validation sandbox is an
 * idempotent webhook routed to the bundled local simulator. Both process gates
 * are re-checked in the worker so a forged run envelope cannot enable it.
 */
export function isProviderSimulationToolInvocation(tool: string, input: unknown): boolean {
  if (
    !isProviderSimulationRuntimeAvailable()
    || tool !== "webhook.send"
    || !input
    || typeof input !== "object"
    || Array.isArray(input)
  ) {
    return false;
  }
  const inputObj = input as Record<string, unknown>;
  if (
    typeof inputObj.url !== "string"
    || !isLocalWebhookPlaceholder(inputObj.url)
    || !idempotencyHeader(inputObj)
  ) {
    return false;
  }
  try {
    const destination = resolveLocalWebhookDestination(inputObj.url);
    return isLocalIntegrationSimulatorEndpoint(destination, "/webhook");
  } catch {
    return false;
  }
}
