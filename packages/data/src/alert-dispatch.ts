/**
 * DI seam for the recovery alerting subsystem. Decouples the event
 * producers (DLQ adapter in engine, budget-gate in api, limiter-degraded
 * audit in data) from the dispatcher implementation (lives in engine).
 *
 * Production wiring: `apps/api/src/alerts-bootstrap.ts` calls
 * `setAlertDispatcher(dispatchAlert)` at boot — both in the API process
 * (so budget-gate fires immediately) and in the worker process (so DLQ
 * inserts fire immediately).
 *
 * Mirrors the `setUsageRecorder` / `setBudgetChecker` pattern: data layer
 * owns the seam, engine + api both write through it.
 */

import type { AlertTrigger } from "@janusly/shared";

export type AlertEvent = {
  /** Tenant orgId, OR the literal `"system"` sentinel for limiter-degraded. */
  orgId: string;
  trigger: AlertTrigger;
  payload: Record<string, unknown>;
};

export type AlertDispatcher = (event: AlertEvent) => Promise<void>;

let dispatcher: AlertDispatcher | null = null;

/**
 * Register the production dispatcher. Called at API + worker boot. Safe to
 * call multiple times — the last registration wins.
 */
export function setAlertDispatcher(d: AlertDispatcher | null): void {
  dispatcher = d;
}

/**
 * Record an alert event for downstream dispatch. Never throws on caller
 * (event producers must never break their primary flow because the
 * alerting subsystem is down). When no dispatcher is registered this is a
 * silent no-op — used by tests and by processes that boot without the
 * alerts module.
 */
export async function recordAlertEvent(event: AlertEvent): Promise<void> {
  if (!dispatcher) return;
  try {
    await dispatcher(event);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[alerts] dispatcher failed", { err, trigger: event.trigger });
  }
}

/** Internal accessor for tests. Production code uses `recordAlertEvent`. */
export function getAlertDispatcher(): AlertDispatcher | null {
  return dispatcher;
}
