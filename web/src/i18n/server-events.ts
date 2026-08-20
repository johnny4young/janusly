/**
 * Translate server-emitted strings on the client. The server stays
 * locale-blind — it emits stable codes plus structured metadata, and these
 * helpers look up `<surface>.<code>` in the catalog.
 *
 * When a code is unknown (engine added a new code that nobody mirrored to
 * `en/common.json` yet) we fall back to the original `message` field via
 * `serverEvents.fallback` so the operator still sees something readable.
 *
 * Used by: components that render validation issues, readiness badges, AI
 * review issues, run timelines, failure clusters, and SSO callback errors.
 */

import { getResolvedLocale, t } from './runtime'
import type { RunEvent, ValidationIssue } from '../types'

/** Sentinel returned by the catalog runtime when no server code matched. */
const MISSING = '__MISSING__'

/**
 * Resolve a SERVER-COMPUTED catalog key (`<surface>.<code>`). The key union
 * cannot be statically typed — the code half originates on the server — so
 * this helper is the single dynamic-key boundary for server-owned codes. It always applies the `MISSING` sentinel default
 * so callers can fall back to the server's literal message. Don't scatter
 * `t(key as any)` casts; add the key to the catalog or route through here.
 */
function tServerCode(key: string, options: Record<string, unknown> = {}): string {
  return t(key, { defaultValue: MISSING, ...options })
}

/** Generic free-form wrapper. Returns the message verbatim today; one place to prefix later. */
export function tServerFallback(message: string | undefined | null): string {
  if (!message) return ''
  return t('serverEvents.fallback', { message })
}

/** Translate a `ValidationIssue.code` to a localized string, falling back to its `message`. */
export function tValidationIssue(issue: ValidationIssue): string {
  const key = `validation.${issue.code}`
  const translated = tServerCode(key, {
    nodeId: issue.nodeId ?? '',
    edgeId: issue.edgeId ?? '',
  })
  return translated === MISSING ? tServerFallback(issue.message) : translated
}

/** Readiness issue from `/workflows/readiness` (same shape as ValidationIssue + severity). */
export type ReadinessIssue = {
  code: string
  message: string
  severity: 'info' | 'warn' | 'fail'
  nodeId?: string
  edgeId?: string
}
export function tReadinessIssue(issue: ReadinessIssue): string {
  const key = `readiness.${issue.code}`
  const translated = tServerCode(key, {
    nodeId: issue.nodeId ?? '',
    edgeId: issue.edgeId ?? '',
  })
  if (translated !== MISSING) return translated
  const validationPrefix = 'invalid_workflow_'
  if (issue.code.startsWith(validationPrefix)) {
    return tValidationIssue({
      ...issue,
      code: issue.code.slice(validationPrefix.length),
    })
  }
  return tServerFallback(issue.message)
}

/** AI review issue (from `/ai/review-workflow`). */
export type AiReviewIssue = {
  code: string
  severity: 'info' | 'warn' | 'fail'
  message: string
  nodeId?: string
  edgeId?: string
  rationale?: string
  suggestion?: string
}
export function tAiReviewIssue(issue: AiReviewIssue): string {
  const key = `aiReview.${issue.code}`
  const translated = tServerCode(key, {
    nodeId: issue.nodeId ?? '',
    edgeId: issue.edgeId ?? '',
  })
  return translated === MISSING ? tServerFallback(issue.message) : translated
}

/** Run timeline event. `event.type` is a stable string like `run.started`, `node.failed`, etc. */
export function tRunEvent(event: RunEvent): string {
  const key = `runEvents.${event.type}`
  const interpolation: Record<string, unknown> = {
    nodeId: event.nodeId ?? '',
    ...(event.payload && typeof event.payload === 'object' ? event.payload : {}),
  }
  const translated = tServerCode(key, interpolation)
  if (translated !== MISSING) return translated
  // No catalog entry — surface a debug-friendly description so operators still
  // get a hint of what happened on the timeline.
  return tServerFallback(`${event.type}${event.nodeId ? ` (${event.nodeId})` : ''}`)
}

/**
 * Failure-cluster signature shape (subset of the full FailureCluster type).
 * `signatureCode` is the closed-enum tag from `normalizeErrorSignature`.
 */
export type FailureClusterSignature = {
  signatureCode: string
  signatureLabel: string
  signatureMeta?: Record<string, unknown>
}
export function tFailureCluster(cluster: FailureClusterSignature): string {
  const key = `failureClusters.${cluster.signatureCode}`
  const translated = tServerCode(key, {
    ...(cluster.signatureMeta ?? {}),
  })
  return translated === MISSING ? tServerFallback(cluster.signatureLabel) : translated
}

export type HealthBreakdownEntryLike = {
  rationale: string
  rationaleCode?: string
  rationaleMeta?: Record<string, string | number | boolean>
}

export function tHealthRationale(entry: HealthBreakdownEntryLike): string {
  if (!entry.rationaleCode) return tServerFallback(entry.rationale)

  if (entry.rationaleCode === 'maintainability.summary') {
    const meta = entry.rationaleMeta ?? {}
    return t('healthRationale.maintainability.summary', {
      outputs: t(meta.hasOutputs ? 'healthRationale.maintainability.outputsDeclared' : 'healthRationale.maintainability.noOutputs'),
      versions: meta.hasMultipleVersions
        ? t('healthRationale.maintainability.multipleVersions', { count: asNumber(meta.versionCount) })
        : t('healthRationale.maintainability.singleVersion'),
      approval: t(meta.hasApprovalNode ? 'healthRationale.maintainability.approvalPresent' : 'healthRationale.maintainability.noApproval'),
    })
  }

  const key = `healthRationale.${entry.rationaleCode}`
  const translated = tServerCode(key, {
    ...(entry.rationaleMeta ?? {}),
    totalTokens: formatNumber(entry.rationaleMeta?.totalTokens),
  })
  return translated === MISSING ? tServerFallback(entry.rationale) : translated
}

export type RecoveryMetricLike = {
  rationale: string
  rationaleCode?: string
  rationaleMeta?: Record<string, string | number | boolean>
}

export function tRecoveryMetricRationale(metric: RecoveryMetricLike): string {
  if (!metric.rationaleCode) return tServerFallback(metric.rationale)
  const key = `recoveryMetricRationale.${metric.rationaleCode}`
  const translated = tServerCode(key, {
    ...(metric.rationaleMeta ?? {}),
  })
  return translated === MISSING ? tServerFallback(metric.rationale) : translated
}

/**
 * Translate a server template's display fields. Server emits stable
 * `nameCode` / `descriptionCode` / `categoryCode` slugs alongside the
 * literal English `name` / `description` / `category` fallbacks. Catalog
 * keys live under `templates.<nameCode>` / `templates.<descriptionCode>`
 * / `templates.category.<categoryCode>`. Adding a new template = no
 * client change beyond mirroring the keys when localisation is wanted —
 * unmirrored templates render the server's literal text.
 */
export type TemplateLike = {
  name: string
  description: string
  category: string
  nameCode?: string
  descriptionCode?: string
  categoryCode?: string
}
export function tTemplateName(template: TemplateLike): string {
  if (!template.nameCode) return tServerFallback(template.name)
  const key = `templates.${template.nameCode}`
  const translated = tServerCode(key)
  return translated === MISSING ? tServerFallback(template.name) : translated
}
export function tTemplateDescription(template: TemplateLike): string {
  if (!template.descriptionCode) return tServerFallback(template.description)
  const key = `templates.${template.descriptionCode}`
  const translated = tServerCode(key)
  return translated === MISSING ? tServerFallback(template.description) : translated
}
export function tTemplateCategory(template: TemplateLike): string {
  if (!template.categoryCode) return tServerFallback(template.category)
  const key = `templates.category.${template.categoryCode}`
  const translated = tServerCode(key)
  return translated === MISSING ? tServerFallback(template.category) : translated
}

/**
 * Translate a server API error envelope. The envelope shape lives in
 * the Go API as `{ error, code, params? }`. The
 * server stays locale-blind; this helper resolves `apiErrors.<code>`
 * from the catalog, interpolates any `params`, and falls back to the
 * literal `error` string (or empty when neither is present).
 *
 * Used by the toast paths in MembersPanel / PermissionGrantsPanel /
 * McpConnectionsPanel / DeadLettersPanel / BudgetSettingsPanel via
 * `addToast(tApiError(err), 'error')`. The error object surfaced by
 * `api.ts` is an `ApiError` with `code` / `params` fields preserved
 * from the response body; plain `Error` instances still work — the
 * helper reads only `message` and falls back to `tServerFallback`.
 */
export type ApiErrorLike = {
  code?: string;
  error?: string;
  message?: string;
  params?: Record<string, unknown>;
};
export function tApiError(envelope: ApiErrorLike | Error | unknown): string {
  if (!envelope) return '';
  const obj = envelope as ApiErrorLike;
  const code = typeof obj.code === 'string' ? obj.code : undefined;
  const fallback = typeof obj.error === 'string'
    ? obj.error
    : typeof obj.message === 'string'
      ? obj.message
      : undefined;
  if (code) {
    const key = `apiErrors.${code}`;
    const translated = tServerCode(key, {
      ...(obj.params ?? {}),
    });
    if (translated !== MISSING) return translated;
  }
  return tServerFallback(fallback ?? '');
}

/**
 * Translate a server tool's description. Tool `name` (`slack.post`,
 * `http.request`) is a stable identifier and stays English. Catalog
 * key is `tools.<descriptionCode>.description`; falls back to the
 * server's literal `description` when the key is missing.
 */
export type ToolLike = {
  description: string
  descriptionCode?: string
}
export function tToolDescription(tool: ToolLike): string {
  if (!tool.descriptionCode) return tServerFallback(tool.description)
  const key = `tools.${tool.descriptionCode}.description`
  const translated = tServerCode(key)
  return translated === MISSING ? tServerFallback(tool.description) : translated
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

function formatNumber(value: unknown): string | undefined {
  return typeof value === 'number'
    ? new Intl.NumberFormat(getResolvedLocale()).format(value)
    : undefined
}
