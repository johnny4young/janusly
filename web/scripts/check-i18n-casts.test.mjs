import assert from "node:assert/strict";
import test from "node:test";

import { findTranslationStringAssertions } from "./check-i18n-casts.mjs";

test("finds direct and nested t(...) as string assertions", () => {
  const findings = findTranslationStringAssertions(`
    const direct = t("one") as string;
    const nested = t("outer", { value: t("inner") as string }) as string;
  `);

  assert.equal(findings.length, 3);
  assert.deepEqual(findings.map((finding) => finding.line), [2, 3, 3]);
});

test("finds wrapped, conditional, double, and qualified translation assertions", () => {
  const findings = findTranslationStringAssertions(`
    const wrapped = (t("wrapped")) as string;
    const conditional = (enabled ? t("on") : t("off")) as string;
    const doubled = (t("double") as unknown) as string;
    const qualified = i18n.t("qualified") as string;
  `);

  assert.equal(findings.length, 4);
  assert.deepEqual(findings.map((finding) => finding.line), [2, 3, 4, 5]);
});

test("ignores typed translations and unrelated string assertions", () => {
  const findings = findTranslationStringAssertions(`
    const translated = t("one");
    const unrelated = value as string;
    const helper = tApiError(error) as string;
  `);

  assert.deepEqual(findings, []);
});
