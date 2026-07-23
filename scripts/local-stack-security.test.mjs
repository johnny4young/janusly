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
  assert.equal(safeStatusCalls?.length, 1);
  assert.doesNotMatch(source, /run\(\s*"pnpm",\s*\["exec", "supabase", "status"\]\s*\)/);
});

test("sensitive command failures omit captured stderr", () => {
  assert.match(source, /!options\.sensitive\s*&&\s*stderr/);
});

test("local Supabase supplies the only database without CLI telemetry", () => {
  assert.match(source, /SUPABASE_TELEMETRY_DISABLED: "1"/);
  assert.match(source, /DO_NOT_TRACK: "1"/);
  assert.match(source, /const databaseUrl = status\.DB_URL/);
  assert.match(source, /JANUSLY_LOCAL_DATABASE_URL: containerUrl\(databaseUrl\)/);
  assert.doesNotMatch(source, /postgres:5432\/workflow/);
});
