/**
 * `JanuslyClient` — the orchestrator. Holds the shared `JanuslyClientConfig`
 * and binds the four resource classes.
 *
 * Resource-style API (Stripe / Octokit pattern): consumers reach methods
 * via `client.runs.start(...)` instead of flat `client.startRun(...)`. The
 * grouping reads as "what I'm operating on", and lets future resources
 * (e.g. `client.prompts` when PromptOps gains an external surface) extend
 * cleanly.
 */

import { RecoveryResource } from "./resources/recovery.js";
import { ReportsResource } from "./resources/reports.js";
import { RunsResource } from "./resources/runs.js";
import { WebhooksResource } from "./resources/webhooks.js";
import type { JanuslyClientConfig } from "./types.js";

export class JanuslyClient {
  /** Run lifecycle: start, list, get, poll, stream events, resume nodes. */
  readonly runs: RunsResource;
  /** Run-explain report downloads. */
  readonly reports: ReportsResource;
  /** Operations dashboard metrics. */
  readonly recovery: RecoveryResource;
  /** Inbound webhook signature verifier (local; no HTTP). */
  readonly webhooks: WebhooksResource;

  constructor(config: JanuslyClientConfig) {
    if (!config.baseUrl || typeof config.baseUrl !== "string") {
      throw new TypeError("JanuslyClient: config.baseUrl is required");
    }
    if (!config.orgId || typeof config.orgId !== "string") {
      throw new TypeError("JanuslyClient: config.orgId is required");
    }
    if (!config.auth || typeof config.auth !== "object") {
      throw new TypeError("JanuslyClient: config.auth is required");
    }
    if (config.auth.kind !== "service-token" && config.auth.kind !== "bearer") {
      throw new TypeError(`JanuslyClient: unknown auth.kind: ${String((config.auth as { kind?: unknown }).kind)}`);
    }
    if (typeof config.auth.token !== "string" || config.auth.token.length === 0) {
      throw new TypeError("JanuslyClient: config.auth.token is required");
    }

    this.runs = new RunsResource(config);
    this.reports = new ReportsResource(config);
    this.recovery = new RecoveryResource(config);
    this.webhooks = new WebhooksResource();
  }
}
