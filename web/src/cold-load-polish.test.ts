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
 * (2) The ordered CSS modules imported by `index.css` MUST contain a universal
 *     `@media (prefers-reduced-motion: reduce)` block with `!important` on
 *     both `animation-duration` and `transition-duration`. Without
 *     `!important` the universal selector `*` loses specificity battles
 *     against every class-scoped rule and the motion-off becomes a no-op.
 *
 * Both tests use `readFileSync` with URLs resolved against `import.meta.url`
 * so they survive any vitest cwd posture.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// pnpm runs the package's `test` script with cwd = apps/web, which is also
// vitest's default `root`. Reading from the package root is the most portable
// way to find these files — `import.meta.url` lives behind Vite's transform
// and resolves to a non-file URL under vitest, so file-URL helpers throw.
const PACKAGE_ROOT = process.cwd();
const indexHtml = readFileSync(resolve(PACKAGE_ROOT, "index.html"), "utf8");
const indexCssPath = resolve(PACKAGE_ROOT, "src/index.css");
const indexCss = readFileSync(indexCssPath, "utf8");
const expectedLocalCssImports = [
  "./styles/foundations.css",
  "./styles/control-plane.css",
  "./styles/navigation.css",
  "./styles/workflow.css",
  "./styles/platform.css",
  "./styles/accessibility.css",
];
const deferredCanvasCssImport = "../styles/canvas.css";
const localCssImports = [...indexCss.matchAll(/@import\s+"([^"]+\.css)"/g)]
  .map((match) => match[1])
  .filter((importPath) => importPath.startsWith("./"));
const cssBundleSource = [
  indexCss,
  ...readdirSync(resolve(PACKAGE_ROOT, "src/styles"))
    .filter((name) => name.endsWith(".css"))
    .map((name) =>
      readFileSync(resolve(PACKAGE_ROOT, "src/styles", name), "utf8"),
    ),
];
const joinedCssBundleSource = cssBundleSource.join("\n");

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const fullPath = resolve(dir, name);
      if (statSync(fullPath).isDirectory()) return listSourceFiles(fullPath);
      return /\.(css|ts|tsx)$/.test(name) ? [fullPath] : [];
    });
}

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

describe("CSS module graph", () => {
  it("pins the complete load-bearing import order", () => {
    expect(localCssImports).toEqual(expectedLocalCssImports);
  });

  it("keeps shared CSS eager and canvas CSS behind the canvas boundary", () => {
    const styleModulePaths = readdirSync(resolve(PACKAGE_ROOT, "src/styles"))
      .filter((name) => name.endsWith(".css"))
      .map((name) => `./styles/${name}`)
      .sort();
    expect([...localCssImports, "./styles/canvas.css"].sort()).toEqual(styleModulePaths);
    expect(new Set(localCssImports).size).toBe(localCssImports.length);
    for (const importPath of localCssImports) {
      const source = readFileSync(resolve(dirname(indexCssPath), importPath), "utf8");
      expect(source, `${importPath} must not hide nested CSS imports`).not.toMatch(/@import\s+/);
    }
    const canvasSource = readFileSync(
      resolve(PACKAGE_ROOT, "src/components/CanvasWorkspace.tsx"),
      "utf8",
    );
    expect(canvasSource).toContain(`import '${deferredCanvasCssImport}'`);
  });
});

describe("universal reduced-motion rule", () => {
  it("CSS contains the universal @media block with !important on durations", () => {
    // Match the section 24 universal block specifically — three-comma selector
    // `*, *::before, *::after` inside `@media (prefers-reduced-motion: reduce)`.
    const block = joinedCssBundleSource.match(
      /@media\s+\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\*,\s*\*::before,\s*\*::after\s*\{([^}]+)\}/,
    );
    expect(block, "expected universal reduced-motion block in the ordered CSS modules").not.toBeNull();
    const body = block![1];
    expect(body).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(body).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });

  it("preserves at least one scoped @media (prefers-reduced-motion) block", () => {
    // Defensive: ensures the universal block is additive, not a replacement
    // for the component-scoped blocks that override with `animation: none`.
    const matches = joinedCssBundleSource.match(/@media\s+\(prefers-reduced-motion:\s*reduce\)/g);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("design token aliases", () => {
  it("defines every Janusly CSS custom property used by web source files", () => {
    const defined = new Set(
      [...joinedCssBundleSource.matchAll(/--([A-Za-z0-9_-]+)\s*:/g)].map((match) => `--${match[1]}`),
    );
    const missing = new Map<string, Set<string>>();

    for (const file of listSourceFiles(resolve(PACKAGE_ROOT, "src"))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/var\((--we-[A-Za-z0-9_-]+)/g)) {
        const token = match[1];
        if (defined.has(token)) continue;
        const relativePath = relative(PACKAGE_ROOT, file);
        const files = missing.get(token) ?? new Set<string>();
        files.add(relativePath);
        missing.set(token, files);
      }
    }

    expect(
      [...missing.entries()].map(([token, files]) => `${token}: ${[...files].join(", ")}`),
    ).toEqual([]);
  });
});
