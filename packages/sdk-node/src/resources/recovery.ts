/**
 * Recovery resource — exposes the operations dashboard's recovery-metrics rollup.
 *
 * Maps 1:1 to `GET /recovery/metrics?windowDays=…`. The response carries
 * `successRate`, `mttr`, `p95Latency`, `approvalsPending`, `replayRate`,
 * `slaAttainment`, and `costThisWindow` (with per-provider rows).
 * Severity + rationale are
 * server-emitted so the SDK doesn't re-derive them.
 */

import { sendApiRequest } from "../request.ts";
import type {
  JanuslyClientConfig,
  JanuslyRequestOptions,
  RecoveryMetrics,
} from "../types.ts";

export class RecoveryResource {
  private readonly config: JanuslyClientConfig;

  constructor(config: JanuslyClientConfig) {
    this.config = config;
  }

  /**
   * GET /recovery/metrics — fetch the recovery metrics rollup.
   *
   * `windowDays` defaults server-side to 30 (matches the Recovery Center).
   * Range 1..90 enforced server-side; values outside the range fall back
   * to the default.
   */
  async getMetrics(
    query?: { windowDays?: number },
    options?: JanuslyRequestOptions,
  ): Promise<RecoveryMetrics> {
    const params = new URLSearchParams();
    if (query?.windowDays !== undefined) {
      params.set("windowDays", String(query.windowDays));
    }
    const path = params.toString().length > 0
      ? `/recovery/metrics?${params.toString()}`
      : "/recovery/metrics";
    return (await sendApiRequest(
      this.config,
      { method: "GET", path },
      options,
    )) as RecoveryMetrics;
  }
}
