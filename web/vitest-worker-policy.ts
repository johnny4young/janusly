export const WEB_TEST_WORKER_CEILING = 3

export function resolveWebTestWorkerLimit(availableWorkers: number): number {
  return Math.min(WEB_TEST_WORKER_CEILING, Math.max(1, Math.floor(availableWorkers)))
}
