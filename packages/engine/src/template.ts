/**
 * Template engine for node configs and tool inputs. Substitutes
 * `{{context.<nodeId>.output.<field>}}`, `{{inputs.<field>}}`,
 * `{{secret.NAME}}`, and `{{env.NAME}}` references. Tracks which resolved
 * secret values were substituted so `execute-node.ts:redactValues` can
 * strip them from outputs before persistence.
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

import { getSecret } from "./secrets";

/** Walk a dotted path through `source`. Returns `undefined` on any null link. */
export function getByPath(source: any, path: string) {
  return path.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    return acc[key];
  }, source);
}

function renderTemplateInternal(value: any, scope: Record<string, any>, redactionList: Set<string>): any {
  if (typeof value === 'string') {
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
        return process.env[envName] ?? '';
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

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderTemplateInternal(item, scope, redactionList)]));
  }

  return value;
}

/** Render a value's template strings without tracking redactions (no secrets in scope). */
export function renderTemplate(value: any, scope: Record<string, any>): any {
  return renderTemplateInternal(value, scope, new Set());
}

/**
 * Render a template AND return the set of secret VALUES that were substituted
 * during the render. The caller is expected to post-process any persisted
 * output through `redactValues(output, redactedValues)` so plaintext secrets
 * never end up in `run_nodes.state_json` or `run_events.payload`.
 */
/**
 * Render a value's template strings AND collect every resolved
 * `{{secret.NAME}}` value into `redactedValues`. The caller passes that
 * list to `redactValues` after the executor runs.
 */
export function renderTemplateWithRedactions(
  value: any,
  scope: Record<string, any>,
): { rendered: any; redactedValues: string[] } {
  const list = new Set<string>();
  const rendered = renderTemplateInternal(value, scope, list);
  return { rendered, redactedValues: Array.from(list) };
}

/**
 * Walk a value recursively and replace any string-occurrence of `redactedValues`
 * with `[redacted]`. Used post-execution to scrub secrets from outputs before
 * they are persisted to run_nodes / run_events.
 */
/**
 * Recursively replace any string occurrences of `redactedValues` (e.g.
 * resolved secrets) with the literal `"[REDACTED]"`. Applied to executor
 * outputs and `waiting` metadata before they reach `run_nodes.state_json`.
 */
export function redactValues(value: any, redactedValues: string[]): any {
  if (redactedValues.length === 0) return value;
  if (typeof value === 'string') {
    let next = value;
    for (const secret of redactedValues) {
      if (!secret) continue;
      next = next.split(secret).join('[redacted]');
    }
    return next;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValues(item, redactedValues));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValues(item, redactedValues)]));
  }
  return value;
}

/** Render a mapping object/string against `scope`. Used by `transform` / `loop` / tool inputs. */
export function mapInput(mapping: any, scope: Record<string, any>) {
  return renderTemplate(mapping ?? {}, scope);
}
