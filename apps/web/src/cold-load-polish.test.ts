/**
 * Static-file tests for the cold-load polish bundle.
 *
 * Two contracts pinned here:
 *
 * (1) The `<link rel="preload" as="style">` in `index.html` MUST point at
 *     the exact same `href` as the `<link rel="stylesheet">` below it.
 *     If they diverge, the browser issues two fetches instead of one and
 *     the preload becomes wasted bandwidth instead of a head-start.
 *
 * (2) `index.css` MUST contain a universal `@media (prefers-reduced-motion:
 *     reduce)` block with `!important` on both `animation-duration` and
 *     `transition-duration`. Without `!important` the universal selector
 *     `*` loses specificity battles against every class-scoped rule and
 *     the motion-off becomes a no-op for users who opted in.
 *
 * Both tests use `readFileSync` with URLs resolved against `import.meta.url`
 * so they survive any vitest cwd posture.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// pnpm runs the package's `test` script with cwd = apps/web, which is also
// vitest's default `root`. Reading from the package root is the most portable
// way to find these files — `import.meta.url` lives behind Vite's transform
// and resolves to a non-file URL under vitest, so file-URL helpers throw.
const PACKAGE_ROOT = process.cwd();
const indexHtml = readFileSync(resolve(PACKAGE_ROOT, "index.html"), "utf8");
const indexCss = readFileSync(resolve(PACKAGE_ROOT, "src/index.css"), "utf8");

describe("font preload link", () => {
  it("preload href matches stylesheet href byte-for-byte", () => {
    const preloadMatch = indexHtml.match(
      /<link\s+rel="preload"\s+as="style"\s+href="([^"]+)"\s*\/>/,
    );
    const stylesheetMatch = indexHtml.match(
      /<link\s+href="([^"]+)"\s+rel="stylesheet"\s*\/>/,
    );
    expect(preloadMatch?.[1], "preload link not found in index.html").toBeDefined();
    expect(stylesheetMatch?.[1], "stylesheet link not found in index.html").toBeDefined();
    expect(preloadMatch![1]).toBe(stylesheetMatch![1]);
  });

  it("preload uses the google fonts host (sanity check)", () => {
    expect(indexHtml).toMatch(
      /<link\s+rel="preload"\s+as="style"\s+href="https:\/\/fonts\.googleapis\.com\/css2\?/,
    );
  });
});

describe("universal reduced-motion rule", () => {
  it("CSS contains the universal @media block with !important on durations", () => {
    // Match the section 24 universal block specifically — three-comma selector
    // `*, *::before, *::after` inside `@media (prefers-reduced-motion: reduce)`.
    const block = indexCss.match(
      /@media\s+\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\*,\s*\*::before,\s*\*::after\s*\{([^}]+)\}/,
    );
    expect(block, "expected universal reduced-motion block in index.css").not.toBeNull();
    const body = block![1];
    expect(body).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(body).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });

  it("preserves at least one scoped @media (prefers-reduced-motion) block", () => {
    // Defensive: ensures the universal block is additive, not a replacement
    // for the component-scoped blocks that override with `animation: none`.
    const matches = indexCss.match(/@media\s+\(prefers-reduced-motion:\s*reduce\)/g);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
