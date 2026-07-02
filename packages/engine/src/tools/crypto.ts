/**
 * Crypto tools (`crypto.sha256` / `.hmac` / `.uuid`) over `node:crypto`.
 *
 * Used by: `packages/engine/src/tool-registry.ts` (spreads `cryptoTools`).
 */

import { z } from "zod";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { defineTool } from "./tool-types";

const cryptoSha256Input = z.object({ value: z.string() });
const cryptoSha256Output = z.object({ digest: z.string() });

const cryptoHmacInput = z.object({
  value: z.string(),
  secret: z.string().min(1),
  algorithm: z.enum(["sha256", "sha512"]).optional(),
});
const cryptoHmacOutput = z.object({ digest: z.string() });

const cryptoUuidOutput = z.object({ value: z.string() });

export const cryptoTools = {
  "crypto.sha256": defineTool({
    name: "crypto.sha256",
    description: "Compute the SHA-256 digest of `value` (hex-encoded).",
    inputSchema: cryptoSha256Input,
    outputSchema: cryptoSha256Output,
    inputExample: { value: "hello" },
    async execute(input) {
      return { digest: createHash("sha256").update(input.value).digest("hex") };
    },
  }),

  "crypto.hmac": defineTool({
    name: "crypto.hmac",
    description: "Compute an HMAC of `value` with `secret` (default `sha256`, `sha512` allowed).",
    inputSchema: cryptoHmacInput,
    outputSchema: cryptoHmacOutput,
    inputExample: { value: "hello", secret: "topsecret" },
    async execute(input) {
      const algorithm = input.algorithm ?? "sha256";
      return { digest: createHmac(algorithm, input.secret).update(input.value).digest("hex") };
    },
  }),

  "crypto.uuid": defineTool({
    name: "crypto.uuid",
    description: "Generate a v4 UUID via the platform crypto random source.",
    inputSchema: z.object({}),
    outputSchema: cryptoUuidOutput,
    inputExample: {},
    async execute() {
      return { value: randomUUID() };
    },
  }),
};
