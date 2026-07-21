/** Pure maintenance-worker configuration and scheduler migration policy. */

import type { Queue } from "bullmq";

/** Safe default that isolates maintenance without serializing every repair. */
export const MAINTENANCE_WORKER_CONCURRENCY_DEFAULT = 2;

/** Hard ceiling that prevents maintenance from becoming customer contention. */
export const MAINTENANCE_WORKER_CONCURRENCY_MAX = 4;

/** One recurring scheduler and the function that installs its replacement. */
export type MaintenanceSchedulerSpec = {
  id: string;
  label: string;
  register: () => Promise<boolean>;
};

/** Boot-time registration and legacy-retirement counters. */
export type MaintenanceSchedulerMigrationResult = {
  registered: number;
  retiredLegacy: number;
};

/** Resolve a deliberately low and closed maintenance concurrency. */
export function resolveMaintenanceWorkerConcurrency(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return MAINTENANCE_WORKER_CONCURRENCY_DEFAULT;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAINTENANCE_WORKER_CONCURRENCY_MAX
    ? parsed
    : MAINTENANCE_WORKER_CONCURRENCY_DEFAULT;
}

/** Register replacements before retiring their queue-local legacy schedulers. */
export async function migrateMaintenanceSchedulers(
  specs: readonly MaintenanceSchedulerSpec[],
  legacyQueue: Pick<Queue, "removeJobScheduler">,
): Promise<MaintenanceSchedulerMigrationResult> {
  let registered = 0;
  let retiredLegacy = 0;

  for (const spec of specs) {
    let succeeded = false;
    try {
      succeeded = await spec.register();
    } catch (error) {
      console.error(`[${spec.label}] scheduler registration failed`, error);
    }
    if (!succeeded) continue;

    registered += 1;
    console.log(`[${spec.label}] maintenance scheduler registered`);
    try {
      if (await legacyQueue.removeJobScheduler(spec.id)) retiredLegacy += 1;
    } catch (error) {
      console.warn(`[${spec.label}] legacy workflow scheduler retirement failed`, error);
    }
  }

  return { registered, retiredLegacy };
}
