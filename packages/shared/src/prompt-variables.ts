/**
 * Shared schema for PromptOps variable declarations.
 *
 * A `PromptVariable` describes one named input that a prompt template
 * expects. The resolver in `packages/engine/src/prompt-resolver.ts` walks
 * the variables array at resolution time and:
 *
 *   1. Reads the calling node's `variables` context bag.
 *   2. For each declared variable with `required: true`, throws
 *      `MissingVariableError` if the bag has no entry for that name.
 *   3. For non-required variables, falls back to `defaultValue` when the
 *      bag has no entry; if no default is set, the `{{var.X}}` token
 *      substitutes to an empty string.
 *
 * The shape is shared via `@janusly/shared` so the repo (DB JSONB read /
 * write), the resolver (variable substitution), and any future Web UI
 * (variable-editor form) all agree on the same TypeScript type.
 *
 * Invariants:
 *   - `name` matches `/^[a-zA-Z_][a-zA-Z0-9_]*$/` so it can be referenced
 *     as `{{var.<name>}}` without escaping.
 *   - `type` is a closed enum so future renderers (form, JSON-schema
 *     export) can switch exhaustively.
 *   - `defaultValue` is optional and only honored when `required: false`.
 *     Required variables that fail to be supplied at call time must
 *     surface as `MissingVariableError` BEFORE the LLM call — the cost
 *     of token spend is the rationale.
 *
 * Used by:
 *   - `packages/data/src/promptsRepo.ts` — write/read against the
 *     `prompt_versions.variables` JSONB column.
 *   - `packages/engine/src/prompt-resolver.ts` — runtime validation +
 *     substitution.
 *   - `apps/api/src/routes/prompts-routes.ts` — body validation on
 *     `POST /prompts/:name/versions`.
 */

import { z } from "zod";

/** Closed enum of supported prompt-variable types. */
export const PROMPT_VARIABLE_TYPES = ["string", "number", "boolean", "json"] as const;
export type PromptVariableType = (typeof PROMPT_VARIABLE_TYPES)[number];

/** Identifier shape: must be a valid `{{var.X}}` token segment. */
export const PROMPT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Zod schema for a single variable declaration. Imported by the repo (for
 * `prompt_versions.variables` JSONB validation) and by the routes (for
 * body validation on version creation).
 */
export const PromptVariableSchema = z.object({
  name: z
    .string()
    .min(1, "Variable name is required")
    .max(64, "Variable name too long (max 64 chars)")
    .regex(PROMPT_VARIABLE_NAME_PATTERN, "Variable name must match /^[a-zA-Z_][a-zA-Z0-9_]*$/"),
  type: z.enum(PROMPT_VARIABLE_TYPES),
  required: z.boolean(),
  defaultValue: z.unknown().optional(),
  description: z.string().max(500).optional(),
});

export type PromptVariable = z.infer<typeof PromptVariableSchema>;

/**
 * Top-level shape stored in `prompt_versions.variables` (JSONB). Validates
 * an entire declaration array; caps at 64 variables per version
 * (defensive — prompts with that many inputs probably need to be split).
 */
export const PromptVariablesSchema = z
  .array(PromptVariableSchema)
  .max(64, "A prompt version cannot declare more than 64 variables");

/**
 * The shape of a `promptRef` attached to an `ai` or `agent` node config.
 * `version` is optional — when absent, the resolver falls back to the
 * pinned version (or the latest published version if no pin exists).
 */
export const PromptRefSchema = z.object({
  name: z
    .string()
    .min(1, "promptRef.name is required")
    .max(128, "promptRef.name too long (max 128 chars)"),
  version: z.number().int().positive().optional(),
});

export type PromptRef = z.infer<typeof PromptRefSchema>;
