import assert from "node:assert/strict";
import test from "node:test";
import { assertCleanInstallRequest } from "./local-clean-install-policy.mjs";

test("clean installation requires real identity and explicit destructive consent", () => {
  assert.throws(
    () => assertCleanInstallRequest(["--confirm-reset"]),
    /real local identity profile/,
  );
  assert.throws(
    () => assertCleanInstallRequest(["--auth"]),
    /repeat with --confirm-reset/,
  );
  assert.doesNotThrow(
    () => assertCleanInstallRequest(["--auth", "--confirm-reset"]),
  );
});
