import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./local-supabase.mjs", import.meta.url), "utf8");

test("Supabase lifecycle commands capture credential-bearing output", () => {
  assert.match(
    source,
    /const supabaseCli = fileURLToPath\(\s*new URL\("\.\.\/node_modules\/supabase\/dist\/supabase\.js", import\.meta\.url\),\s*\)/,
  );
  assert.match(
    source,
    /function runSupabase\(argumentsList, options = \{\}\)/,
  );
  assert.match(
    source,
    /const startArguments = \[\s*"start",\s*"--network-id",\s*localSupabaseNetwork,\s*"-x",\s*authExclusions,\s*\]/,
  );
  assert.match(
    source,
    /runSupabase\(startArguments, \{ sensitive: true \}\)/,
  );
  assert.match(
    source,
    /runSupabase\(\["status", "-o", "env"\], \{\s*sensitive: true,\s*\}\)/,
  );
  assert.doesNotMatch(source, /runSupabase\(\["status"(?:, "-o", "env")?\]\s*\)/);
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
