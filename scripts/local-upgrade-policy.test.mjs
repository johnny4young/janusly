import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUpgradeQualificationRequest,
  validateMigrationUpgrade,
} from "./local-upgrade-policy.mjs";

const migration = (name, sha256) => ({
  path: `packages/db/migrations/${name}/migration.sql`,
  sha256,
});

test("upgrade qualification requires explicit destructive consent", () => {
  assert.throws(
    () => assertUpgradeQualificationRequest([]),
    /repeat with --confirm-reset/,
  );
  assert.doesNotThrow(
    () => assertUpgradeQualificationRequest(["--confirm-reset"]),
  );
});

test("migration upgrade accepts an exact historical prefix plus additions", () => {
  const baseline = [migration("20260101000000_base", "a")];
  const added = migration("20260201000000_additive", "b");
  assert.deepEqual(
    validateMigrationUpgrade(baseline, [...baseline, added]),
    [added],
  );
});

test("migration upgrade rejects edits, insertion, removal, and no-op candidates", () => {
  const baseline = [
    migration("20260101000000_base", "a"),
    migration("20260201000000_second", "b"),
  ];
  assert.throws(
    () => validateMigrationUpgrade(baseline, baseline),
    /add at least one migration/,
  );
  assert.throws(
    () => validateMigrationUpgrade(
      baseline,
      [
        migration("20260101000000_base", "changed"),
        ...baseline.slice(1),
        migration("20260301000000_new", "c"),
      ],
    ),
    /historical migration prefix changed/,
  );
  assert.throws(
    () => validateMigrationUpgrade(
      baseline,
      [
        migration("20251201000000_inserted", "z"),
        ...baseline,
      ],
    ),
    /historical migration prefix changed/,
  );
});
