/**
 * Text-transform tools (`text.uppercase` / `.lowercase` / `.trim` /
 * `.replace` / `.regex`) plus the RE2-backed safe-regex helpers.
 *
 * Used by: `packages/engine/src/tool-registry.ts` (spreads `textTools`).
 */

import { z } from "zod";
import { RE2 } from "re2-wasm";
import { defineTool } from "./tool-types";

function normalizeRegexFlags(flags?: string): string {
  const raw = flags ?? "g";
  if (!/^[gimsuy]*$/.test(raw)) {
    throw new Error("Unsupported regular expression flags; use only g, i, m, s, u, y");
  }
  const unique = new Set<string>();
  for (const flag of raw) {
    if (unique.has(flag)) {
      throw new Error(`Duplicate regular expression flag: ${flag}`);
    }
    unique.add(flag);
  }
  unique.add("u");
  return Array.from(unique).join("");
}

function createSafeRegex(pattern: string, flags?: string): RE2 {
  return new RE2(pattern, normalizeRegexFlags(flags));
}

const textUppercaseInput = z.object({
  value: z.string().min(1),
});
const textUppercaseOutput = z.object({
  value: z.string(),
});

const textValueInput = z.object({ value: z.string() });
const textValueOutput = z.object({ value: z.string() });

const textReplaceInput = z.object({
  value: z.string(),
  search: z.string().min(1),
  replacement: z.string(),
  all: z.boolean().optional(),
});
const textRegexInput = z.object({
  value: z.string(),
  pattern: z.string().min(1),
  flags: z.string().optional(),
  group: z.number().int().min(0).optional(),
}).superRefine((input, ctx) => {
  try {
    createSafeRegex(input.pattern, input.flags);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid regular expression";
    ctx.addIssue({
      code: "custom",
      path: message.includes("Unsupported regular expression flags") || message.includes("Duplicate regular expression flag") ? ["flags"] : ["pattern"],
      message,
    });
  }
});
const textRegexOutput = z.object({ matches: z.array(z.string()) });

export const textTools = {
  "text.uppercase": defineTool({
    name: "text.uppercase",
    description: "Convert text to uppercase.",
    inputSchema: textUppercaseInput,
    outputSchema: textUppercaseOutput,
    inputExample: { value: "hello" },
    async execute(input) {
      return { value: input.value.toUpperCase() };
    },
  }),

  "text.lowercase": defineTool({
    name: "text.lowercase",
    description: "Convert text to lowercase.",
    inputSchema: textValueInput,
    outputSchema: textValueOutput,
    inputExample: { value: "HELLO" },
    async execute(input) {
      return { value: input.value.toLowerCase() };
    },
  }),

  "text.trim": defineTool({
    name: "text.trim",
    description: "Trim leading and trailing whitespace from text.",
    inputSchema: textValueInput,
    outputSchema: textValueOutput,
    inputExample: { value: "  hello  " },
    async execute(input) {
      return { value: input.value.trim() };
    },
  }),

  "text.replace": defineTool({
    name: "text.replace",
    description: "Replace literal occurrences of a substring (all by default).",
    inputSchema: textReplaceInput,
    outputSchema: textValueOutput,
    inputExample: { value: "hello world", search: "world", replacement: "there" },
    async execute(input) {
      const all = input.all ?? true;
      return {
        value: all
          ? input.value.split(input.search).join(input.replacement)
          : input.value.replace(input.search, input.replacement),
      };
    },
  }),

  "text.regex": defineTool({
    name: "text.regex",
    description: "Match a regular expression against text and return capture groups.",
    inputSchema: textRegexInput,
    outputSchema: textRegexOutput,
    inputExample: { value: "user@example.com", pattern: "([^@]+)@(.+)", group: 1 },
    async execute(input) {
      const re = createSafeRegex(input.pattern, input.flags);
      const matches: string[] = [];
      const maxIterations = 1000; // Defense-in-depth against runaway patterns.
      if (re.global) {
        let count = 0;
        let m: ReturnType<RE2["exec"]>;
        while ((m = re.exec(input.value)) !== null) {
          if (count++ >= maxIterations) break;
          matches.push(input.group !== undefined ? (m[input.group] ?? "") : (m[0] ?? ""));
          if (m[0] === "") {
            re.lastIndex += 1;
          }
        }
      } else {
        const m = re.exec(input.value);
        if (m) matches.push(input.group !== undefined ? (m[input.group] ?? "") : (m[0] ?? ""));
      }
      return { matches };
    },
  }),
};
