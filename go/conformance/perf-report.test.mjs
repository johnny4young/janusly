import assert from "node:assert/strict";
import test from "node:test";

import { replaceHealthyReport, replaceHostileReport } from "./perf-report.mjs";

test("healthy report migration preserves independent appendices", () => {
  const original = "# Old healthy\n\nold table\n\n## Allocation review\n\nkeep me\n\n## Escenario hostil (legacy) — yesterday\n\nkeep until refreshed\n";
  const replaced = replaceHealthyReport(original, "# Current healthy\n\nnew table");

  assert.match(replaced, /janusly:healthy-benchmark:start/);
  assert.match(replaced, /# Current healthy/);
  assert.doesNotMatch(replaced, /old table/);
  assert.match(replaced, /## Allocation review\n\nkeep me/);
  assert.match(replaced, /keep until refreshed/);
});

test("healthy report replacement is bounded and idempotent", () => {
  const migrated = replaceHealthyReport("# Old\n\n## Appendix\n\nkeep\n", "# First");
  const replaced = replaceHealthyReport(migrated, "# Second");

  assert.equal((replaced.match(/healthy-benchmark:start/g) ?? []).length, 1);
  assert.doesNotMatch(replaced, /# First/);
  assert.match(replaced, /# Second/);
  assert.match(replaced, /## Appendix\n\nkeep/);
});

test("hostile report replaces its legacy summary and preserves other evidence", () => {
  const original = "# Healthy\n\n## Allocation review\n\nkeep\n\n## Escenario hostil (legacy) — yesterday\n\nold hostile\n";
  const replaced = replaceHostileReport(original, "## Escenario hostil — today\n\nnew hostile");

  assert.match(replaced, /## Allocation review\n\nkeep/);
  assert.doesNotMatch(replaced, /old hostile/);
  assert.match(replaced, /new hostile/);
  assert.equal((replaced.match(/hostile-benchmark:start/g) ?? []).length, 1);
});

test("malformed markers fail instead of overwriting ambiguous evidence", () => {
  assert.throws(
    () => replaceHealthyReport("<!-- janusly:healthy-benchmark:start -->\nmissing end", "# Current"),
    /malformed generated benchmark section/,
  );
});
