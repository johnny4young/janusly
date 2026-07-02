/**
 * Time tools (`time.now` / `.parse` / `.format` / `.diff` / `.add`) plus the
 * epoch-coercion + unit-scale helpers they share.
 *
 * Used by: `packages/engine/src/tool-registry.ts` (spreads `timeTools`).
 */

import { z } from "zod";
import { parseIsoDuration } from "../iso-duration";
import { defineTool } from "./tool-types";

const TIME_DIFF_UNIT_MS: Record<"ms" | "s" | "m" | "h" | "d", number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function toEpochMs(value: string | number): number {
  if (typeof value === "number") return Math.trunc(value);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid date/time: ${value}`);
  }
  return parsed;
}

const timeNowOutput = z.object({ iso: z.string(), epochMs: z.number() });

const timeParseInput = z.object({ value: z.union([z.string(), z.number()]) });
const timeParseOutput = z.object({ iso: z.string(), epochMs: z.number() });

const timeFormatInput = z.object({
  value: z.union([z.string(), z.number()]),
  format: z.enum(["iso", "epoch", "epochSeconds", "utc", "rfc2822"]),
});
const timeFormatOutput = z.object({ value: z.union([z.string(), z.number()]) });

const timeDiffInput = z.object({
  a: z.union([z.string(), z.number()]),
  b: z.union([z.string(), z.number()]),
  unit: z.enum(["ms", "s", "m", "h", "d"]).optional(),
});
const timeDiffOutput = z.object({ value: z.number() });

const timeAddInput = z.object({
  value: z.union([z.string(), z.number()]),
  duration: z.string().min(1),
});
const timeAddOutput = z.object({ iso: z.string(), epochMs: z.number() });

export const timeTools = {
  "time.now": defineTool({
    name: "time.now",
    description: "Return the current time as ISO + epoch milliseconds.",
    inputSchema: z.object({}),
    outputSchema: timeNowOutput,
    inputExample: {},
    async execute() {
      const epochMs = Date.now();
      return { iso: new Date(epochMs).toISOString(), epochMs };
    },
  }),

  "time.parse": defineTool({
    name: "time.parse",
    description: "Parse an ISO-8601 string or numeric epoch (ms) into both forms.",
    inputSchema: timeParseInput,
    outputSchema: timeParseOutput,
    inputExample: { value: "2026-01-01T00:00:00Z" },
    async execute(input) {
      const epochMs = toEpochMs(input.value);
      return { iso: new Date(epochMs).toISOString(), epochMs };
    },
  }),

  "time.format": defineTool({
    name: "time.format",
    description: "Format a time value in one of `iso`/`epoch`/`epochSeconds`/`utc`/`rfc2822`.",
    inputSchema: timeFormatInput,
    outputSchema: timeFormatOutput,
    inputExample: { value: "2026-01-01T00:00:00Z", format: "epoch" },
    async execute(input) {
      const epochMs = toEpochMs(input.value);
      const date = new Date(epochMs);
      switch (input.format) {
        case "iso":
          return { value: date.toISOString() };
        case "epoch":
          return { value: epochMs };
        case "epochSeconds":
          return { value: Math.trunc(epochMs / 1000) };
        case "utc":
          return { value: date.toUTCString() };
        case "rfc2822":
          return { value: date.toUTCString() };
      }
    },
  }),

  "time.diff": defineTool({
    name: "time.diff",
    description: "Compute b - a as a duration in `unit` (default ms).",
    inputSchema: timeDiffInput,
    outputSchema: timeDiffOutput,
    inputExample: { a: "2026-01-01T00:00:00Z", b: "2026-01-04T00:00:00Z", unit: "d" },
    async execute(input) {
      const diffMs = toEpochMs(input.b) - toEpochMs(input.a);
      const unit = input.unit ?? "ms";
      return { value: diffMs / TIME_DIFF_UNIT_MS[unit] };
    },
  }),

  "time.add": defineTool({
    name: "time.add",
    description: "Add an ISO 8601 duration (e.g. `P3D`, `PT2H30M`) to a time value.",
    inputSchema: timeAddInput,
    outputSchema: timeAddOutput,
    inputExample: { value: "2026-01-01T00:00:00Z", duration: "P3D" },
    async execute(input) {
      const baseMs = toEpochMs(input.value);
      const offsetMs = parseIsoDuration(input.duration);
      if (offsetMs === null) {
        throw new Error(`Invalid ISO 8601 duration: ${input.duration}`);
      }
      const epochMs = baseMs + offsetMs;
      return { iso: new Date(epochMs).toISOString(), epochMs };
    },
  }),
};
