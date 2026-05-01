/**
 * Secret value resolution + reference scanning. `{{secret.NAME}}` template
 * strings resolve to `process.env.NAME` at run time; the resolved values
 * never reach persistence — `template.ts:renderTemplateWithRedactions`
 * tracks which values to strip and `execute-node.ts` applies the redaction
 * before the executor's output lands in `run_nodes.state_json`.
 *
 * Used by `template.ts` (the template renderer is the only resolver call
 * site) and by `apps/api/src/index.ts` `POST /credentials` validation
 * (`listSecretRefs`).
 *
 * Invariants:
 * - The persist-side guarantee — never write resolved secret values to the
 *   DB — is enforced in `execute-node.ts` via `redactValues`. Don't bypass.
 */

/** Resolve a `{{secret.NAME}}` reference to `process.env.NAME`; throws when missing. */
export function getSecret(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing secret: ${name}`);
  }

  return value;
}

/** Collect the unique set of `{{secret.NAME}}` reference names found anywhere in `value`. */
export function listSecretRefs(value: any): string[] {
  const refs = new Set<string>();

  function visit(input: any) {
    if (typeof input === "string") {
      for (const match of input.matchAll(/{{\s*secret\.([A-Z0-9_]+)\s*}}/gi)) {
        refs.add(match[1]);
      }
      return;
    }

    if (Array.isArray(input)) {
      input.forEach(visit);
      return;
    }

    if (typeof input === "object" && input !== null) {
      Object.values(input).forEach(visit);
    }
  }

  visit(value);
  return Array.from(refs);
}

/** Identity rewriter for `{{secret.NAME}}` placeholders — preserves them for display without resolving. */
export function maskSecrets(value: any): any {
  if (typeof value === "string") {
    return value.replace(/{{\s*secret\.([A-Z0-9_]+)\s*}}/gi, "{{secret.$1}}");
  }

  if (Array.isArray(value)) {
    return value.map(maskSecrets);
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskSecrets(item)]));
  }

  return value;
}
