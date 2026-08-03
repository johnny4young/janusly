import assert from "node:assert/strict";
import test from "node:test";

import { classifySupabasePostgres18Probe } from "./supabase-postgres18-policy.mjs";

test("recognizes the current explicit major 18 rejection", () => {
  assert.deepEqual(classifySupabasePostgres18Probe({
    status: 1,
    stderr: "Failed reading config: Invalid db.major_version: 18.",
  }), {
    configAccepted: false,
    operational: false,
    reason: "major_18_rejected",
  });
});

test("separates config acceptance from Docker availability", () => {
  assert.deepEqual(classifySupabasePostgres18Probe({
    status: 1,
    stderr: "Cannot connect to the Docker daemon",
  }), {
    configAccepted: true,
    operational: false,
    reason: "major_18_accepted_environment_unavailable",
  });
  assert.deepEqual(classifySupabasePostgres18Probe({ status: 0, stdout: "[]" }), {
    configAccepted: true,
    operational: true,
    reason: "major_18_accepted",
  });
});

test("unrelated config parse failures remain unknown and fail closed", () => {
  assert.throws(
    () => classifySupabasePostgres18Probe({
      status: 1,
      stderr: "Failed reading config: invalid auth.redirect_urls",
    }),
    /unrelated reason/u,
  );
});
