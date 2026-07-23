import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./local-stack.mjs", import.meta.url), "utf8");

test("Supabase lifecycle commands capture credential-bearing output", () => {
  assert.match(
    source,
    /run\(\s*"pnpm",\s*\["exec", "supabase", "start", "-x", authExclusions\],\s*\{ sensitive: true \}\s*\)/,
  );

  const safeStatusCalls = source.match(
    /run\(\s*"pnpm",\s*\["exec", "supabase", "status", "-o", "env"\],\s*\{ sensitive: true \},?\s*\)/g,
  );
  assert.equal(safeStatusCalls?.length, 2);
  assert.doesNotMatch(source, /run\(\s*"pnpm",\s*\["exec", "supabase", "status"\]\s*\)/);
});

test("sensitive command failures omit captured stderr", () => {
  assert.match(source, /!options\.sensitive\s*&&\s*stderr/);
});
