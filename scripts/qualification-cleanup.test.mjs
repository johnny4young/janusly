import assert from "node:assert/strict";
import test from "node:test";
import { runQualificationWithCleanup } from "./qualification-cleanup.mjs";

test("qualification returns its result only after cleanup succeeds", async () => {
  const calls = [];
  const result = await runQualificationWithCleanup(
    async () => {
      calls.push("qualify");
      return { ok: true };
    },
    async () => {
      calls.push("cleanup");
    },
    "test qualification",
  );

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ["qualify", "cleanup"]);
});

test("qualification failure still runs cleanup", async () => {
  const calls = [];
  await assert.rejects(
    runQualificationWithCleanup(
      async () => {
        calls.push("qualify");
        throw new Error("qualification failed");
      },
      async () => {
        calls.push("cleanup");
      },
      "test qualification",
    ),
    /qualification failed/u,
  );
  assert.deepEqual(calls, ["qualify", "cleanup"]);
});

test("cleanup failure prevents a successful qualification result", async () => {
  await assert.rejects(
    runQualificationWithCleanup(
      async () => ({ ok: true }),
      async () => {
        throw new Error("cleanup failed");
      },
      "test qualification",
    ),
    /cleanup failed/u,
  );
});

test("qualification and cleanup failures retain both causes", async () => {
  await assert.rejects(
    runQualificationWithCleanup(
      async () => {
        throw new Error("qualification failed");
      },
      async () => {
        throw new Error("cleanup failed");
      },
      "test qualification",
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /test qualification and cleanup failed/u);
      assert.deepEqual(
        error.errors.map((cause) => cause.message),
        ["qualification failed", "cleanup failed"],
      );
      return true;
    },
  );
});
