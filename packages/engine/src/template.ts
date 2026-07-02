/**
 * Template engine for node configs and tool inputs. Substitutes
 * `{{context.<nodeId>.output.<field>}}`, `{{inputs.<field>}}`,
 * `{{secret.NAME}}`, and `{{env.NAME}}` references. Tracks every resolved
 * secret AND env value (length >= 4) in a redaction list so
 * `execute-node.ts` can strip plaintext from outputs and thrown errors before
 * persistence. Env vars are common carriers for API keys (e.g.
 * `OPENAI_API_KEY`, `JANUSLY_API_SERVICE_TOKEN`), so they get the same
 * scrub treatment as the explicit `{{secret.*}}` channel.
 *
 * Used by `execute-node.ts` (every node-config render),
 * `node-registry.ts:loop` (per-iteration mapping), and tool executors
 * that template their inputs.
 *
 * Invariants:
 * - The renderer never persists resolved values — it returns the rendered
 *   payload + a list of values to redact. The caller is responsible for
 *   applying `redactValues` before any DB write.
 * - Empty / missing path resolves to `""` (string interpolation), not the
 *   literal `undefined` — this is the contract `apps/web` relies on for
 *   user-friendly templating.
 */

import { redactValues } from "@janusly/shared/src/safe-persist";

import { getSecret } from "./secrets";

export type TemplateScope = Record<string, unknown>;

function isTemplateRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPathContainer(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Detect a `ReadableStream`-shaped value. Streams cannot be templated into
 * strings — interpolating one would either coerce to `[object ReadableStream]`
 * (useless) or surface as an opaque error downstream. We throw with the
 * resolved path so the operator can spot which `{{...}}` reference is
 * pointing at a stream-typed context value.
 *
 * The streaming-mode HTTP executor always pre-consumes into a preview before
 * returning, so context values reachable from a template should never be a
 * live stream in practice. This guard is defense-in-depth for the rare path
 * where a stream escapes its executor invocation.
 */
function isReadableStreamLike(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (typeof (globalThis as { ReadableStream?: unknown }).ReadableStream !== 'undefined'
    && value instanceof (globalThis as { ReadableStream: { new (): unknown } }).ReadableStream) {
    return true;
  }
  const v = value as { getReader?: unknown; tee?: unknown };
  return typeof v.getReader === 'function' && typeof v.tee === 'function';
}

/**
 * Thrown when a template / expression / mapping resolves a `{{...}}` path
 * to a `ReadableStream`. The `.path` field carries the offending dotted
 * reference so the operator sees exactly which node output is the source.
 */
export class StreamValueInTemplateError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`Refusing to template a ReadableStream value at path ${path}; streams must be consumed within their executor (see consumeStreamToPreview).`);
    this.name = 'StreamValueInTemplateError';
    this.path = path;
  }
}

/** Walk a dotted path through `source`. Returns `undefined` on any null link. Throws `StreamValueInTemplateError` if the terminal value is a `ReadableStream`. */
export function getByPath(source: unknown, path: string): unknown {
  const resolved = path.split('.').reduce<unknown>((acc, key) => {
    if (!isPathContainer(acc)) return undefined;
    return acc[key];
  }, source);
  if (isReadableStreamLike(resolved)) {
    throw new StreamValueInTemplateError(path);
  }
  return resolved;
}

function renderTemplateInternal(value: unknown, scope: TemplateScope, redactionList: Set<string>): unknown {
  if (typeof value === 'string') {
    // Single-template-reference shape (entire string is one `{{...}}`):
    // return the resolved value as-is so arrays/objects/numbers/booleans
    // survive intact. Without this, `loop.items: "{{context.x.items}}"`
    // would receive a JSON-stringified array (then degrade via CSV-split).
    // Multi-reference strings ("hello {{name}}") still flow through the
    // string-substitution branch below.
    const singleRef = value.match(/^\s*\{\{\s*([^}]+)\s*\}\}\s*$/);
    if (singleRef) {
      const expr = singleRef[1].trim();
      if (expr.startsWith('secret.')) {
        const secretName = expr.replace('secret.', '').toUpperCase();
        const resolved = getSecret(secretName);
        if (resolved && resolved.length >= 4) redactionList.add(resolved);
        return resolved;
      }
      if (expr.startsWith('env.')) {
        const envName = expr.replace('env.', '').toUpperCase();
        const resolved = process.env[envName] ?? '';
        if (resolved && resolved.length >= 4) redactionList.add(resolved);
        return resolved;
      }
      const resolved = getByPath(scope, expr);
      if (resolved == null) return '';
      return resolved;
    }

    return value.replace(/{{\s*([^}]+)\s*}}/g, (_, rawPath) => {
      const expr = String(rawPath).trim();

      if (expr.startsWith('secret.')) {
        const secretName = expr.replace('secret.', '').toUpperCase();
        const resolved = getSecret(secretName);
        if (resolved && resolved.length >= 4) redactionList.add(resolved);
        return resolved;
      }

      if (expr.startsWith('env.')) {
        const envName = expr.replace('env.', '').toUpperCase();
        const resolved = process.env[envName] ?? '';
        // Treat env values like secrets: any sufficiently long resolved value
        // is added to the redaction list so it gets scrubbed from outputs
        // before persistence. The 4-char floor avoids over-redacting toy
        // values like "0", "1", "dev", or "prod" — short non-secrets render
        // verbatim. Same length floor as the secret branch above.
        if (resolved && resolved.length >= 4) redactionList.add(resolved);
        return resolved;
      }

      const resolved = getByPath(scope, expr);

      if (resolved == null) return '';
      if (typeof resolved === 'object') return JSON.stringify(resolved);
      return String(resolved);
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => renderTemplateInternal(item, scope, redactionList));
  }

  if (isTemplateRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderTemplateInternal(item, scope, redactionList)]));
  }

  return value;
}

/**
 * Render a value's template strings without tracking redactions.
 *
 * Overloads honestly express the return type:
 * - **string input** can return `unknown` — a single-template-reference
 *   string (`"{{x}}"`) returns the resolved value's native type, which
 *   could be a number, array, object, or boolean. Callers must narrow.
 * - **object / array / primitive input** preserves its structural shape.
 *   Nested single-ref strings inside the structure return raw values too,
 *   but at the top level the return type matches the input type.
 */
export function renderTemplate(value: string, scope: TemplateScope): unknown;
export function renderTemplate<T>(value: T, scope: TemplateScope): T;
export function renderTemplate<T>(value: T, scope: TemplateScope): T | unknown {
  return renderTemplateInternal(value, scope, new Set()) as T;
}

/**
 * Render a value's template strings AND collect every resolved
 * `{{secret.NAME}}` / `{{env.NAME}}` value into `redactedValues`. The
 * caller passes that list to `redactValues` / `redactError` before any
 * executor result or failure is persisted.
 */
export function renderTemplateWithRedactions(
  value: unknown,
  scope: TemplateScope,
): { rendered: unknown; redactedValues: string[] } {
  const list = new Set<string>();
  const rendered = renderTemplateInternal(value, scope, list);
  return { rendered, redactedValues: Array.from(list) };
}

/**
 * Recursively replace any string occurrences of `redactedValues` (e.g.
 * resolved secret/env values) with the literal `"[redacted]"`. Applied to
 * executor outputs and `waiting` metadata before persistence.
 *
 * Implementation lives in `@janusly/shared/src/safe-persist` (single
 * source shared with `safePersistPayload` and the data layer); re-exported
 * here so existing engine imports keep working.
 */
export { redactValues };

/**
 * Redact resolved secret/env values from thrown errors before the runtime
 * serializes them into retry events, node failures, or DLQ rows. `Error`
 * fields such as `message` and `stack` are non-enumerable, so the generic
 * object walk in `redactValues` cannot handle them by itself.
 */
export function redactError(error: unknown, redactedValues: string[]): unknown {
  if (redactedValues.length === 0) return error;
  if (error instanceof Error) {
    error.message = redactValues(error.message, redactedValues);
    if (error.stack) error.stack = redactValues(error.stack, redactedValues);

    const errorRecord = error as Error & {
      cause?: unknown;
      code?: unknown;
      statusCode?: unknown;
    };
    if (errorRecord.cause !== undefined) errorRecord.cause = redactValues(errorRecord.cause, redactedValues);
    if (errorRecord.code !== undefined) errorRecord.code = redactValues(errorRecord.code, redactedValues);
    return error;
  }
  return redactValues(error, redactedValues);
}

/** Render a mapping object/string against `scope`. Used by `transform` / `loop` / tool inputs. */
export function mapInput<T>(mapping: T | null | undefined, scope: TemplateScope): T | Record<string, never> {
  return renderTemplate((mapping ?? {}) as T | Record<string, never>, scope);
}
