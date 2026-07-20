import assert from "node:assert/strict";
import test from "node:test";

import { scanPublicContent } from "./check-public-repo-hygiene.mjs";

test("rejects internal work-item identifiers", () => {
  const violations = scanPublicContent("docs/example.md", "Delivered ENG-123 yesterday.");

  assert.deepEqual(violations, [
    {
      file: "docs/example.md",
      line: 1,
      label: "internal work item",
      match: "ENG-123",
    },
  ]);
});

test("rejects references to private planning paths", () => {
  const violations = scanPublicContent(
    "README.md",
    "See docs/proposals/idea.md.\nThe old source was docs/PLAN.md.",
  );

  assert.deepEqual(
    violations.map(({ label, match }) => ({ label, match })),
    [
      { label: "private planning path", match: "docs/proposals/" },
      { label: "private planning path", match: "docs/PLAN.md" },
    ],
  );
});

test("accepts durable behavioral rationale", () => {
  assert.deepEqual(
    scanPublicContent(
      "packages/engine/src/example.ts",
      "Do not bypass the queue adapter because it owns durable publication.",
    ),
    [],
  );
});

test("excludes enforcement fixtures and the ignore file", () => {
  assert.deepEqual(scanPublicContent(".gitignore", "docs/private/"), []);
  assert.deepEqual(
    scanPublicContent("scripts/check-public-repo-hygiene.test.mjs", "ENG-999"),
    [],
  );
});
