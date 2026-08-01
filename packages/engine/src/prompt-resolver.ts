/**
 * PromptOps registry runtime resolver.
 *
 * Converts a `promptRef: { name, version? }` into a flattened template
 * string suitable for passing as the `system` or `prompt` field to
 * `LlmClient.generateText` / `generateObject`. The single chokepoint from
 * a workflow author's `promptRef` declaration to a resolved prompt body —
 * never inline a `db.select` from `prompt_versions` in a node executor
 * or AI route handler; route through this module instead.
 *
 * Two substitution passes happen here, in order:
 *
 *   1. `{{include.Y}}` — resolves to the active version of prompt `Y` in
 *      the SAME org as the calling node. Depth-first traversal with a
 *      visited-set keyed by `promptId` rejects cycles. Defensive cap at
 *      depth 8 (`MAX_INCLUDE_DEPTH`) rejects unbounded chains long
 *      after a real cycle would have been detected.
 *
 *   2. `{{var.X}}` — resolves from the calling node's `nodeContext.variables`
 *      bag against the declared `variables` array on the active version.
 *      Required variables missing → `MissingVariableError` thrown BEFORE
 *      the LLM call (no token spend on a call that would fail).
 *
 * The output of this resolver is the INPUT to the existing engine
 * template substituter (`packages/engine/src/template.ts`) which handles
 * `{{secret.X}}`, `{{input.X}}`, `{{env.X}}`, etc. The two layers
 * intentionally use disjoint prefixes — `var.` and `include.` belong to
 * this resolver; the others belong to the engine substituter. Anything
 * else (a bare `{{foo}}` token) passes through untouched so the engine
 * substituter can decide.
 *
 * Multi-tenant scope is structural: the only DB reads are via
 * `promptsRepo.getPromptByName(orgId, ...)` and
 * `promptsRepo.resolveActiveVersion(orgId, ...)`. Cross-org includes are
 * impossible — a missing prompt in the calling org surfaces as
 * `MissingPromptError`, not a silent fallback to another org's prompt.
 *
 * Used by:
 *   - `packages/engine/src/node-executors/ai.ts` — `ai` node executor calls
 *     `resolvePromptRef` before the LLM invocation when
 *     `config.promptRef` is present.
 *   - `packages/engine/src/agent-planner.ts` — agent planner consults
 *     `config.systemPromptRef` to override the hardcoded planner prompt.
 *   - Future AI surface routes that opt into the registry.
 */

import {
  getPromptByName,
  getPromptVersion,
  resolveActiveVersion,
  type Prompt,
  type PromptVersion,
} from "@janusly/data";
import type { PromptRef, PromptVariable } from "@janusly/shared";

/** Defensive cap on `{{include.X}}` chain depth. Cycle detection should
 *  reject any real cycle long before this cap engages — it exists as a
 *  defense-in-depth backstop for a future bug. */
export const MAX_INCLUDE_DEPTH = 8;

/**
 * The resolved output handed back to the caller. `resolvedText` is the
 * fully-flattened template string ready for the LLM; `declaredVars` is the
 * variables list from the resolved version (so the caller can log which
 * variables were available); `promptId` + `version` identify the exact
 * version that was used (for audit + observability).
 */
export type ResolvedPrompt = {
  promptId: string;
  promptName: string;
  version: number;
  resolvedText: string;
  declaredVars: PromptVariable[];
};

/** Input bag passed to `resolvePromptRef`. */
export type ResolvePromptInput = {
  orgId: string;
  ref: PromptRef;
  /**
   * Context the calling node supplies. `variables` is the `{{var.X}}`
   * substitution bag — typically lifted from the node config's
   * `variables` field, but the executor controls the shape.
   */
  nodeContext?: {
    variables?: Record<string, unknown>;
  };
};

// ─── typed errors ───────────────────────────────────────────────────

/** Prompt name not found in the calling org. */
export class MissingPromptError extends Error {
  readonly code = "missing_prompt";
  constructor(public readonly promptName: string) {
    super(`Prompt "${promptName}" not found in org`);
    this.name = "MissingPromptError";
  }
}

/** A specific `(promptName, version)` was requested but the version doesn't exist. */
export class MissingPromptVersionError extends Error {
  readonly code = "missing_prompt_version";
  constructor(public readonly promptName: string, public readonly version: number) {
    super(`Prompt "${promptName}" version ${version} not found`);
    this.name = "MissingPromptVersionError";
  }
}

/** The prompt has no published versions yet. */
export class NoPromptVersionsError extends Error {
  readonly code = "no_prompt_versions";
  constructor(public readonly promptName: string) {
    super(`Prompt "${promptName}" has no versions yet — create one first`);
    this.name = "NoPromptVersionsError";
  }
}

/** A required declared variable was not supplied in the calling node's context. */
export class MissingVariableError extends Error {
  readonly code = "missing_variable";
  constructor(public readonly variableName: string, public readonly promptName: string) {
    super(`Variable "${variableName}" is required by prompt "${promptName}" but not supplied`);
    this.name = "MissingVariableError";
  }
}

/** An `{{include.X}}` chain forms a cycle. The `cyclePath` array names
 *  each prompt traversed, ending with the offending repeat. */
export class RecursivePromptIncludeError extends Error {
  readonly code = "recursive_prompt_include";
  constructor(public readonly cyclePath: readonly string[]) {
    super(`Recursive {{include}} detected: ${cyclePath.join(" → ")}`);
    this.name = "RecursivePromptIncludeError";
  }
}

/** Depth cap exceeded. Cycle detection should have rejected long before. */
export class PromptIncludeDepthExceededError extends Error {
  readonly code = "prompt_include_depth_exceeded";
  constructor(public readonly path: readonly string[]) {
    super(
      `{{include}} depth exceeded ${MAX_INCLUDE_DEPTH}: ${path.join(" → ")}`,
    );
    this.name = "PromptIncludeDepthExceededError";
  }
}

// ─── token regex (single source of truth, exported for tests) ────────

/**
 * Matches `{{include.<name>}}` with optional whitespace. The `<name>`
 * shape matches the same identifier pattern as variable names:
 * `[a-zA-Z_][a-zA-Z0-9_]*`. The outer braces are NOT optional — bare
 * `{{include.X}}` is intentional; if the operator wants a literal
 * `{{include.X}}` in the prompt, they can escape with a leading
 * backslash (`\{{include.X}}` is currently passed through verbatim;
 * v1 does not implement escape syntax — documented as a known limitation).
 */
export const INCLUDE_TOKEN_RE = /\{\{\s*include\.([a-zA-Z_][a-zA-Z0-9_-]*)\s*\}\}/g;

/** Matches `{{var.<name>}}` with optional whitespace. */
export const VARIABLE_TOKEN_RE = /\{\{\s*var\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

// ─── public API ─────────────────────────────────────────────────────

/**
 * Resolve a top-level `promptRef` into a flattened template string.
 *
 * Throws one of the typed errors above on failure — never returns a
 * partial / empty string silently. The caller (a node executor) catches
 * and either degrades the run to `failed` with the error code or, for
 * AI surface contracts that demand fallback, surfaces the error as
 * `{ mode: "fallback", aiError: error.code }`.
 */
export async function resolvePromptRef(input: ResolvePromptInput): Promise<ResolvedPrompt> {
  const { orgId, ref, nodeContext } = input;

  // Resolve the root prompt + version.
  const root = await loadVersion(orgId, ref);

  // Walk the include graph DFS-first. The visited set keys by `promptId`
  // — cross-version cycles inside the same prompt are not possible
  // (versions are append-only and don't contain forward references) so
  // promptId is the right granularity.
  const visited = new Set<string>([root.prompt.id]);
  const path: string[] = [root.prompt.name];

  const flattened = await resolveIncludes(
    root.version.templateText,
    orgId,
    visited,
    path,
    /* depth */ 1,
    root.prompt.name,
  );

  // Variable substitution pass. Validates the calling node's context
  // against the declared variables on the ROOT version — included
  // prompts contribute their templates but not their declared variable
  // lists (an included prompt's variables, if any, are resolved with the
  // SAME nodeContext as the root). This is intentional: the root prompt
  // is the contract surface; includes are implementation detail.
  const declaredVars = (root.version.variables ?? []) as PromptVariable[];
  const resolvedText = substituteVariables(
    flattened,
    declaredVars,
    nodeContext?.variables ?? {},
    root.prompt.name,
  );

  return {
    promptId: root.prompt.id,
    promptName: root.prompt.name,
    version: root.version.version,
    resolvedText,
    declaredVars,
  };
}

// ─── internals ──────────────────────────────────────────────────────

type ResolvedRoot = {
  prompt: Prompt;
  version: PromptVersion;
};

async function loadVersion(orgId: string, ref: PromptRef): Promise<ResolvedRoot> {
  const prompt = await getPromptByName(orgId, ref.name);
  if (!prompt) {
    throw new MissingPromptError(ref.name);
  }
  if (typeof ref.version === "number") {
    const version = await getPromptVersion(orgId, prompt.id, ref.version);
    if (!version) {
      throw new MissingPromptVersionError(ref.name, ref.version);
    }
    return { prompt, version };
  }
  const active = await resolveActiveVersion(orgId, prompt.id);
  if (!active) {
    throw new NoPromptVersionsError(ref.name);
  }
  return { prompt: active.prompt, version: active.version };
}

/**
 * Replace every `{{include.X}}` token in `text` with the resolved
 * (recursively-flattened) text of prompt X. Cycle detection rejects via
 * `RecursivePromptIncludeError`; depth-cap rejects via
 * `PromptIncludeDepthExceededError`. Multi-tenant scope: the lookup
 * always uses `orgId` — cross-org includes are structurally impossible.
 */
async function resolveIncludes(
  text: string,
  orgId: string,
  visited: Set<string>,
  path: string[],
  depth: number,
  rootName: string,
): Promise<string> {
  // Collect all distinct include names in this text. The `matchAll`
  // iterator is consumed once; we substitute by name on a second pass.
  const includeNames = new Set<string>();
  for (const m of text.matchAll(INCLUDE_TOKEN_RE)) {
    includeNames.add(m[1]);
  }
  if (includeNames.size === 0) return text;

  // For each distinct include, resolve once (memoized) then substitute
  // all occurrences in `text`. This avoids resolving the same include
  // twice when a single template references it more than once.
  const resolved: Record<string, string> = {};
  for (const name of includeNames) {
    if (depth >= MAX_INCLUDE_DEPTH) {
      throw new PromptIncludeDepthExceededError([...path, name]);
    }
    const includedPrompt = await getPromptByName(orgId, name);
    if (!includedPrompt) {
      // A missing included prompt is treated as a hard error rather
      // than a silent passthrough — the operator opted into `{{include}}`
      // and likely typo'd the name. Diagnose loudly.
      throw new MissingPromptError(name);
    }
    if (visited.has(includedPrompt.id)) {
      // Cycle detected. The cyclePath ends with the repeat so the
      // operator sees exactly which loop trips.
      throw new RecursivePromptIncludeError([...path, name]);
    }

    // Mark as visited BEFORE recursing so a deeper include can see the
    // ancestor chain. Restore on the way out via the structured-clone
    // pattern below (we don't actually clone — visited is mutated then
    // un-mutated after the recursion).
    visited.add(includedPrompt.id);
    path.push(name);

    const includedActive = await resolveActiveVersion(orgId, includedPrompt.id);
    if (!includedActive) {
      throw new NoPromptVersionsError(name);
    }

    const includedFlattened = await resolveIncludes(
      includedActive.version.templateText,
      orgId,
      visited,
      path,
      depth + 1,
      rootName,
    );

    resolved[name] = includedFlattened;

    path.pop();
    visited.delete(includedPrompt.id);
  }

  // Substitute back into the original text. Reset the regex's lastIndex
  // by constructing a fresh matcher — RegExp objects with the `g` flag
  // carry state across calls and would otherwise misbehave on the
  // second pass.
  return text.replace(
    /\{\{\s*include\.([a-zA-Z_][a-zA-Z0-9_-]*)\s*\}\}/g,
    (_match, name: string) => {
      const value = resolved[name];
      // Defensive — `resolved` was populated by the loop above for every
      // distinct name in the text. If somehow not, that's a bug in the
      // resolver itself; throw rather than emit `undefined`.
      if (value === undefined) {
        throw new Error(`resolver bug: include "${name}" did not resolve`);
      }
      return value;
    },
  );
}

/**
 * Substitute `{{var.X}}` tokens with values from `vars`. Validates
 * declared variables: every `required: true` declaration must have a
 * value in `vars` (or fail with `MissingVariableError`). For optional
 * declarations, the resolver uses the declaration's `defaultValue` when
 * `vars` has no entry; if no default and no value, the token resolves to
 * an empty string (intentional — undeclared/optional + missing is
 * lenient by design).
 */
export function substituteVariables(
  text: string,
  declared: readonly PromptVariable[],
  vars: Record<string, unknown>,
  promptName: string,
): string {
  // Build the effective variable map once: declared variables that have
  // a supplied value use that; otherwise fall back to defaultValue.
  // Required + missing is rejected before any substitution work happens.
  const effective: Record<string, unknown> = {};
  for (const decl of declared) {
    if (decl.name in vars) {
      effective[decl.name] = vars[decl.name];
    } else if (decl.required) {
      throw new MissingVariableError(decl.name, promptName);
    } else if (decl.defaultValue !== undefined) {
      effective[decl.name] = decl.defaultValue;
    }
  }
  // Variables in `vars` that weren't declared still substitute — the
  // declared list constrains the REQUIRED check, not the substitution
  // surface. Document that undeclared variables are tolerated so a
  // template author can use `{{var.X}}` for ad-hoc inputs that don't
  // need a declared schema entry.
  for (const [name, value] of Object.entries(vars)) {
    if (!(name in effective)) effective[name] = value;
  }

  return text.replace(
    /\{\{\s*var\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g,
    (_match, name: string) => {
      const value = effective[name];
      if (value === undefined || value === null) return "";
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      // Objects and arrays stringify to JSON — the template author can
      // override per-call via the `type: "json"` declaration if they need
      // structured output, but the default serialization is JSON.
      try {
        return JSON.stringify(value);
      } catch {
        return "";
      }
    },
  );
}
