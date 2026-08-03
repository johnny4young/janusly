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
 * `packages/engine/src/inputs-validator.ts`. Additions such as patterns,
 * numeric ranges, or union types must update that validator in the same
 * change.
 */

import { z } from "zod";

export const workflowInputTypeValues = [
  "string",
  "number",
  "boolean",
  "object",
  "array",
] as const;

export const WorkflowInputTypeSchema = z.enum(workflowInputTypeValues);

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

export const WorkflowInputSchema: z.ZodType<WorkflowInputSchemaShape> =
  z.lazy(() =>
    z.object({
      type: WorkflowInputTypeSchema,
      description: z.string().optional(),
      properties: z
        .record(z.string(), WorkflowInputSchema)
        .optional(),
      required: z.array(z.string()).optional(),
      items: WorkflowInputSchema.optional(),
      enum: z.array(z.unknown()).optional(),
      default: z.unknown().optional(),
    }),
  );
