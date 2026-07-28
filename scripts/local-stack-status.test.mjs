import assert from "node:assert/strict";
import test from "node:test";
import {
  formatLocalStackStatus,
  inspectLocalSupabase,
} from "./local-stack-status.mjs";

test("stopped Supabase becomes a bounded unavailable status", async () => {
  const inspection = await inspectLocalSupabase(async () => {
    throw new Error("captured CLI output must not escape");
  });

  assert.deepEqual(inspection, {
    available: false,
    status: null,
  });
  assert.equal(
    formatLocalStackStatus(inspection, { authEnabled: true }),
    "[local] Supabase unavailable; the persistent stack is stopped or incomplete",
  );
});

test("ready status reveals only the requested local Auth URL", async () => {
  const inspection = await inspectLocalSupabase(async () => ({
    API_URL: "http://127.0.0.1:7431",
    DB_URL: "postgresql://postgres:secret@127.0.0.1:7432/postgres",
    SERVICE_ROLE_KEY: "secret",
  }));

  assert.equal(
    formatLocalStackStatus(inspection, { authEnabled: true }),
    "[local] unified Supabase PostgreSQL ready · Auth http://127.0.0.1:7431",
  );
  assert.equal(
    formatLocalStackStatus(inspection, { authEnabled: false }),
    "[local] unified Supabase PostgreSQL ready",
  );
});
