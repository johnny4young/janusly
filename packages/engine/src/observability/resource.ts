/**
 * OpenTelemetry Resource shared by the tracer and meter providers.
 *
 * Carries `service.name="janusly"`, `service.namespace="janusly"`, and an
 * env-derived `service.instance.id` so multi-instance OTLP/Prometheus
 * dashboards can disambiguate every Janusly process. The Resource is set
 * once on `NodeTracerProvider` (`./otel.ts`) and `MeterProvider`
 * (`./prometheus.ts`); both signals carry the same triple.
 *
 * Used by:
 * - `packages/engine/src/observability/otel.ts` — span Resource.
 * - `packages/engine/src/observability/prometheus.ts` — metric Resource
 *   (surfaces as `target_info{...}` in the Prometheus exposition).
 *
 * Invariants:
 * - `service.name === "janusly"` is the AGENTS.md commitment; setting it
 *   explicitly is what makes that commitment literally true (without a
 *   Resource, OTel falls back to `unknown_service:node`).
 * - `service.instance.id` precedence: `OTEL_SERVICE_INSTANCE_ID` env →
 *   `HOSTNAME` env → `os.hostname()`. Never empty.
 */

import { hostname } from "node:os";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
  ATTR_SERVICE_INSTANCE_ID,
} from "@opentelemetry/semantic-conventions";

/**
 * Resolve a stable per-process identifier so multi-instance OTLP and
 * Prometheus dashboards can disambiguate two Janusly workers writing to the
 * same backend. Order of precedence:
 *  1. `OTEL_SERVICE_INSTANCE_ID` (operator override; e.g. a Kubernetes pod
 *     name surfaced via the downward API).
 *  2. `HOSTNAME` (most container runtimes set this; Docker Compose names it
 *     after the container).
 *  3. `os.hostname()` (developer laptop fallback).
 */
function resolveInstanceId(): string {
  if (process.env.OTEL_SERVICE_INSTANCE_ID) return process.env.OTEL_SERVICE_INSTANCE_ID;
  if (process.env.HOSTNAME) return process.env.HOSTNAME;
  return hostname();
}

// Compose with `defaultResource()` so we keep the SDK-detected attributes
// (`telemetry.sdk.{name,language,version}`, runtime info, etc.) and only
// override `service.*`. Without the merge, `NodeTracerProvider` and
// `MeterProvider` would replace the SDK defaults with our minimal three
// attributes — losing the host/runtime metadata most ops dashboards expect.
// Right-hand operand wins on merge, so our service triple beats the
// default `unknown_service:node` placeholder.
export const janusResource = defaultResource().merge(
  resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "janusly",
    [ATTR_SERVICE_NAMESPACE]: "janusly",
    [ATTR_SERVICE_INSTANCE_ID]: resolveInstanceId(),
  }),
);
