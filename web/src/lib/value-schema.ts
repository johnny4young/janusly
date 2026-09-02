/**
 * Recursive JSON-value schema subset shared by workflow inputs, human forms,
 * AI output declarations, and deterministic recovery outcome detectors.
 *
 * The grammar deliberately stays small:
 * - `type` is one of `workflowInputTypeValues`.
 * - `properties` and `required` describe objects.
 * - `items` describes arrays.
 * - `enum` constrains values to a closed literal set.
 * - `description` is operator-facing metadata.
 * - `default` fills an omitted workflow input before validation.
 *
 * A declared default lets trigger-driven workflows keep configuration in one
 * workflow setting instead of duplicating literals across nodes. A supplied
 * value always wins, including explicit `null` and `false`.
 *
 * Runtime validation and default application live in
 * the backend input validator. Additions such as patterns,
 * numeric ranges, or union types must update that validator in the same
 * change.
 */

import * as z from "zod/mini";

export const workflowInputTypeValues = [
  "string",
  "number",
  "boolean",
  "object",
  "array",
] as const;

export const WorkflowInputTypeSchema = /* @__PURE__ */ z.enum(workflowInputTypeValues);

/**
 * Hand-written because Zod cannot infer the recursive lazy shape without an
 * explicit seed.
 */
export type WorkflowInputSchemaShape = {
  type: (typeof workflowInputTypeValues)[number];
  description?: string;
  properties?: Record<string, WorkflowInputSchemaShape>;
  required?: string[];
  items?: WorkflowInputSchemaShape;
  enum?: unknown[];
  default?: unknown;
};

export const WorkflowInputSchema: z.ZodMiniType<WorkflowInputSchemaShape> =
  /* @__PURE__ */ z.lazy(() =>
    z.object({
      type: WorkflowInputTypeSchema,
      description: z.optional(z.string()),
      properties: z.optional(z.record(z.string(), WorkflowInputSchema)),
      required: z.optional(z.array(z.string())),
      items: z.optional(WorkflowInputSchema),
      enum: z.optional(z.array(z.unknown())),
      default: z.optional(z.unknown()),
    }),
  );
