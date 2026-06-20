/**
 * Property-based fuzz for the free-JSON workflow parser.
 *
 * `parseGeneratedWorkflow` turns arbitrary LLM TEXT into `Workflow | null` on
 * every `/ai/generate-workflow` call in the default (free_json) mode. The
 * AI-fallback contract requires it to NEVER throw — a malformed / adversarial /
 * truncated model reply must degrade to `null`, not an uncaught exception. It's
 * designed that way (`JSON.parse` in try/catch → null; `safeParse` → null); this
 * proves the design holds under ~1000 random + LLM-shaped inputs. `extractJsonObject`
 * (the parser's first step) gets the same never-throws guarantee.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Workflow } from "@janusly/shared";

import { extractJsonObject, parseGeneratedWorkflow } from "./ai-generate-freejson";

/** JSON.stringify that never throws (BigInt etc. → a safe fallback string). */
function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return typeof s === "string" ? s : "null";
  } catch {
    return "null";
  }
}

/** A `Workflow`-or-null check: the only two shapes the parser may return. */
function isWorkflowOrNull(value: Workflow | null): boolean {
  if (value === null) return true;
  return typeof value === "object" && Array.isArray(value.nodes) && Array.isArray(value.edges);
}

/**
 * An `fc.oneof` of adversarial inputs spanning the shapes a model reply can take:
 * raw text, well-formed JSON, markdown-fenced / prose-wrapped / truncated JSON,
 * deeply-nested structures (recursion probe), and workflow-shaped near-misses.
 */
const jsonish = fc.anything().map(safeStringify);
const adversarialInput = fc.oneof(
  // Arbitrary text (incl. control chars, emoji, lone surrogates, stray braces).
  fc.string(),
  fc.string({ maxLength: 2000 }),
  // Well-formed JSON of arbitrary values — valid JSON, (almost) never a workflow.
  jsonish,
  // LLM-shaped wrappers the parser explicitly defends against.
  jsonish.map((s) => "```json\n" + s + "\n```"),
  jsonish.map((s) => "Here is your workflow:\n" + s + "\nLet me know if you need changes."),
  jsonish.map((s) => s.slice(0, Math.max(0, Math.floor(s.length / 2)))), // truncated mid-JSON
  fc.constantFrom("{", "}", "[", "]", "```", "```json", "{\"nodes\":[", ""),
  // Deeply-nested arrays / objects — probe JSON.parse / Zod recursion limits
  // (a RangeError must be caught → null, never propagated).
  fc.integer({ min: 1, max: 1000 }).map((n) => "[".repeat(n) + "]".repeat(n)),
  fc.integer({ min: 1, max: 1000 }).map((n) => '{"a":'.repeat(n) + "1" + "}".repeat(n)),
  // Workflow-shaped garbage — near-miss input that drives the schema reject path.
  fc
    .record({
      nodes: fc.array(
        fc.record({
          id: fc.option(fc.string(), { nil: undefined }),
          type: fc.string(),
          config: fc.option(fc.anything(), { nil: undefined }),
        }),
        { maxLength: 8 },
      ),
      edges: fc.array(fc.record({ from: fc.string(), to: fc.string() }), { maxLength: 8 }),
    })
    .map(safeStringify),
);

describe("parseGeneratedWorkflow — property-based fuzz", () => {
  it("never throws and always returns Workflow | null over ~1000 random + LLM-shaped inputs", () => {
    fc.assert(
      // A throw inside the predicate fails the property and fast-check shrinks
      // to a minimal repro; the return-shape check pins the `Workflow | null` contract.
      fc.property(adversarialInput, (input) => isWorkflowOrNull(parseGeneratedWorkflow(input))),
      { numRuns: 1000 },
    );
  });

  it("does not throw on hand-picked pathological inputs", () => {
    const nasty = [
      "",
      " ",
      "{",
      "}",
      "[",
      "```json```",
      "```json\n```",
      "null",
      "true",
      "42",
      '"just a string"',
      '{"nodes":',
      '{"nodes":[',
      "[]",
      "{}",
      "a".repeat(100_000), // 100 KB of junk (no JSON object)
      "{".repeat(5000) + "}".repeat(5000), // deeply nested, invalid
      "\u0000\uffff\uD800", // NUL + U+FFFF non-character + lone surrogate
    ];
    for (const input of nasty) {
      expect(() => parseGeneratedWorkflow(input)).not.toThrow();
      expect(isWorkflowOrNull(parseGeneratedWorkflow(input))).toBe(true);
    }
  });
});

describe("extractJsonObject — property-based fuzz", () => {
  it("never throws on ~1000 arbitrary strings and always returns a string", () => {
    fc.assert(
      fc.property(fc.string(), (input) => typeof extractJsonObject(input) === "string"),
      { numRuns: 1000 },
    );
  });
});
