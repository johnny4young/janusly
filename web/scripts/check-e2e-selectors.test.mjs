import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ALLOWED_MISSING,
  checkE2ESelectors,
  collectApplicationClasses,
  findSelectorClasses,
  findStaleAllowlistEntries,
} from "./check-e2e-selectors.mjs";

test("finds class tokens in locator and querySelector calls", () => {
  const findings = findSelectorClasses(`
    const hero = page.locator('.ai-studio-hero')
    document.querySelectorAll('.toast-stack')
    await page.locator('.panel .panel-title').click()
  `);

  assert.deepEqual(
    findings.map((finding) => finding.className),
    ["ai-studio-hero", "toast-stack", "panel", "panel-title"],
  );
});

test("finds bare selector strings in overlay-hiding arrays", () => {
  // The regression this ratchet exists for: a stale entry here hides nothing
  // and no assertion ever complains.
  const findings = findSelectorClasses(`
    for (const selector of [
      '.toast-stack',
      '.we-budget-banner',
    ]) {}
  `);

  assert.deepEqual(
    findings.map((finding) => finding.className),
    ["toast-stack", "we-budget-banner"],
  );
});

test("reports the line so a failure points at the call site", () => {
  const findings = findSelectorClasses("\n\nconst a = page.locator('.late-class')\n");
  assert.equal(findings[0].line, 3);
});

test("collects classes from both stylesheets and JSX literals", () => {
  // Exercised against the real tree rather than a fixture: the collector's job
  // is to be exhaustive over the source shapes the app actually uses.
  const classes = collectApplicationClasses(new URL("../src", import.meta.url).pathname);
  assert.ok(classes.has("ai-studio-hero"), "expected a class defined in CSS");
  assert.ok(classes.size > 100, "expected the collector to find the app's classes");
});

test("does not let unit-test-only classes satisfy an E2E selector", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "janusly-selector-ratchet-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "src");
  const e2eRoot = path.join(root, "e2e");
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(e2eRoot);
  fs.writeFileSync(path.join(sourceRoot, "component.css"), ".real-owner { color: red; }\n");
  fs.writeFileSync(
    path.join(sourceRoot, "component.test.tsx"),
    'export const Fixture = () => <div className="test-only" />\n',
  );
  fs.writeFileSync(
    path.join(e2eRoot, "journey.spec.ts"),
    "page.locator('.real-owner'); page.locator('.test-only'); page.locator('.panel-card');\n",
  );

  assert.deepEqual(
    checkE2ESelectors(e2eRoot, sourceRoot).map((finding) => finding.className),
    ["test-only", "panel-card"],
  );
});

test("real allowlist has no stale production owner", () => {
  const sourceRoot = new URL("../src", import.meta.url).pathname;
  assert.deepEqual(findStaleAllowlistEntries(sourceRoot), []);
});

test("allowlist entries each carry a reason and an exact file scope", () => {
  for (const [className, exception] of Object.entries(ALLOWED_MISSING)) {
    assert.ok(exception.reason.trim().length > 0, `${className} has no reason`);
    assert.ok(exception.files.length > 0, `${className} has no file scope`);
    assert.ok(
      exception.files.every((fileName) => fileName.endsWith(".spec.ts")),
      `${className} has an overly broad file scope`,
    );
  }
  assert.ok(
    Object.keys(ALLOWED_MISSING).length <= 6,
    "the allowlist is meant to hold assert-absent selectors, not to absorb drift",
  );
});
