/**
 * Public surface of `@janusly/sdk`. Import shape:
 *
 *   import { JanuslyClient, JanuslyApiError } from "@janusly/sdk";
 *
 * Internal modules (`./request`, `./resources/*`) are NOT exported —
 * consumers reach methods through the client's resource bindings.
 */

export { JanuslyClient } from "./client.ts";
export {
  JanuslyApiError,
  JanuslyAuthError,
  JanuslyValidationError,
  JanuslyRateLimitError,
  JanuslyServerError,
  JanuslyTimeoutError,
  JanuslyWebhookSignatureError,
  parseRetryAfterSeconds,
  type JanuslyApiErrorEnvelope,
} from "./errors.ts";
export { RunsResource } from "./resources/runs.ts";
export { ReportsResource, type RunExplainFormat, type RunExplainExport } from "./resources/reports.ts";
export { RecoveryResource } from "./resources/recovery.ts";
export {
  WebhooksResource,
  type VerifyWebhookSignatureInput,
  type VerifyWebhookSignatureResult,
} from "./resources/webhooks.ts";
export {
  TERMINAL_RUN_STATUSES,
  type JanuslyAuthMode,
  type JanuslyClientConfig,
  type JanuslyLogger,
  type JanuslyRequestOptions,
  type JanuslyRetryConfig,
  type RecoveryCostProviderRow,
  type RecoveryMetric,
  type RecoveryMetricSeverity,
  type RecoveryMetrics,
  type RecoverySlaAttainmentMetric,
  type RunDetails,
  type RunEvent,
  type RunNode,
  type RunNodeStatus,
  type RunStatus,
  type RunSummary,
} from "./types.ts";
