import assert from "node:assert/strict";
import test from "node:test";

import { parseQualificationArgs } from "./run-qualification-profiles.mjs";

test("qualification arguments accept pnpm's explicit separator", () => {
  const options = parseQualificationArgs([
    "--",
    "--profiles=go_web",
    "--output=receipt.json",
    "--evidence=evidence",
  ], "/tmp/janusly-qualification-args");

  assert.equal(options.profiles, "go_web");
  assert.equal(options.confirmDestructive, false);
  assert.equal(options.output, "/tmp/janusly-qualification-args/receipt.json");
  assert.equal(options.evidence, "/tmp/janusly-qualification-args/evidence");
});

test("qualification arguments still reject unknown input", () => {
  assert.throws(() => parseQualificationArgs(["go_web"]), /unknown argument: go_web/u);
});
