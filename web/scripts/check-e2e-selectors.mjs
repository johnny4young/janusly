/**
 * Reject E2E class selectors that no longer exist in the application.
 *
 * `check-css-classes.mjs` guards one direction: every class in the stylesheet
 * has a production owner. Nothing guarded the other direction, so a rename that
 * updated a component but not the Playwright helper left a selector that
 * silently matches nothing. Playwright does not fail on an empty locator until
 * it times out, and the failure it eventually reports names the wrong element,
 * so the real cause stays hidden. That is exactly how `.aiStudio-hero` survived
 * a `copilot` -> `aiStudio` rename while the component shipped
 * `.ai-studio-hero`, and how an overlay-hiding list kept a stale
 * `.we-budget-blocked-banner` that quietly stopped hiding anything -- the kind
 * of defect that makes a screenshot look clean while an overlay covers the
 * element under test.
 *
 * Zero-baseline ratchet: a selector the app does not define must be listed in
 * ALLOWED_MISSING with a reason, or the check fails.
 *
 * Used by: `pnpm lint` and `scripts/check-e2e-selectors.test.mjs`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractCssClassSelectors,
  extractTypeScriptClassReferences,
} from "./check-css-classes.mjs";

/**
 * Classes an E2E file may reference even though the app never defines them.
 * Every entry carries the reason it is legitimate. Keep this list short: an
 * entry that is not one of these two shapes is drift being parked.
 */
export const ALLOWED_MISSING = {
  "panel-card": {
    files: ["css-system-contract.spec.ts"],
    reason: "the CSS contract asserts the legacy card class is absent",
  },
  "sb-pinned": {
    files: ["task-space-navigation.spec.ts"],
    reason: "task-space navigation asserts no pinned sidebar entries remain",
  },
};

/**
 * Class namespaces rendered by third-party code at runtime, so they are absent
 * from `src` by construction. React Flow is the only external namespace; its
 * root class and `react-flow__*` internals are emitted by the dependency.
 */
export const EXTERNAL_CLASSES = ["react-flow"];
export const EXTERNAL_PREFIXES = ["react-flow__"];

/** Collect every class name/prefix production can render, excluding tests. */
export function collectApplicationClassReferences(sourceRoot) {
  const classes = new Set();
  const prefixes = new Set();
  for (const file of listFiles(sourceRoot, /\.(tsx?|css)$/)) {
    if (/\.(?:test|spec)\.tsx?$/.test(file) || file.endsWith(".d.ts")) continue;
    const source = fs.readFileSync(file, "utf8");
    if (file.endsWith(".css")) {
      for (const className of extractCssClassSelectors(source)) classes.add(className);
      continue;
    }
    const references = extractTypeScriptClassReferences(source, file);
    for (const className of references.classes) classes.add(className);
    for (const prefix of references.prefixes) prefixes.add(prefix);
  }
  return { classes, prefixes };
}

export function collectApplicationClasses(sourceRoot) {
  return collectApplicationClassReferences(sourceRoot).classes;
}

/**
 * Return every class token an E2E source references through a selector.
 * Recognises the call shapes the suite actually uses; a selector built at
 * runtime is invisible here, the same limit the route-parity guard carries.
 */
export function findSelectorClasses(source, fileName = "spec.ts") {
  const findings = [];
  const selectorCall = /(?:locator|querySelectorAll|querySelector)\(\s*(["'`])([^"'`\n]+)\1/g;
  for (const match of source.matchAll(selectorCall)) {
    for (const token of match[2].matchAll(/\.([A-Za-z][\w-]*)/g)) {
      findings.push({
        className: token[1],
        line: source.slice(0, match.index).split("\n").length,
        file: fileName,
      });
    }
  }
  // The overlay-hiding helpers pass bare selector strings in an array literal
  // rather than to locator() directly. Those go stale the same way.
  const arraySelector = /["'`](\.[A-Za-z][\w-]*)["'`]\s*,/g;
  for (const match of source.matchAll(arraySelector)) {
    findings.push({
      className: match[1].slice(1),
      line: source.slice(0, match.index).split("\n").length,
      file: fileName,
    });
  }
  return findings;
}

function isAllowed(finding) {
  const exception = Object.hasOwn(ALLOWED_MISSING, finding.className)
    ? ALLOWED_MISSING[finding.className]
    : null;
  if (
    exception
    && exception.files.some((fileName) => path.basename(finding.file) === fileName)
  ) return true;
  if (EXTERNAL_CLASSES.includes(finding.className)) return true;
  return EXTERNAL_PREFIXES.some((prefix) => finding.className.startsWith(prefix));
}

export function checkE2ESelectors(e2eRoot, sourceRoot) {
  const defined = collectApplicationClassReferences(sourceRoot);
  const seen = new Set();
  const findings = [];
  for (const file of listFiles(e2eRoot, /\.tsx?$/)) {
    const source = fs.readFileSync(file, "utf8");
    for (const finding of findSelectorClasses(source, file)) {
      const key = `${finding.className}@${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (
        defined.classes.has(finding.className)
        || Array.from(defined.prefixes).some((prefix) => finding.className.startsWith(prefix))
        || isAllowed(finding)
      ) continue;
      findings.push(finding);
    }
  }
  return findings;
}

/** Report allowlist entries the app now defines, so the list cannot rot. */
export function findStaleAllowlistEntries(sourceRoot) {
  const defined = collectApplicationClassReferences(sourceRoot);
  return Object.keys(ALLOWED_MISSING).filter((className) => (
    defined.classes.has(className)
    || Array.from(defined.prefixes).some((prefix) => className.startsWith(prefix))
  ));
}

/** Walk files recursively without following symlinks. */
export function listFiles(root, pattern) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(absolute, pattern));
    else if (entry.isFile() && pattern.test(entry.name)) files.push(absolute);
  }
  return files;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const findings = checkE2ESelectors(
    path.join(repositoryRoot, "e2e"),
    path.join(repositoryRoot, "src"),
  );
  const stale = findStaleAllowlistEntries(path.join(repositoryRoot, "src"));

  if (findings.length > 0) {
    console.error(`Found ${findings.length} E2E selector(s) the app does not define:`);
    for (const finding of findings) {
      console.error(
        `${path.relative(repositoryRoot, finding.file)}:${finding.line} .${finding.className}`,
      );
    }
    console.error(
      "\nA locator that matches nothing does not fail fast -- it times out and blames\n" +
        "the wrong element. Fix the selector, or add an ALLOWED_MISSING entry with a reason.",
    );
    process.exitCode = 1;
  }
  if (stale.length > 0) {
    console.error(
      `\n${stale.length} ALLOWED_MISSING entr(ies) now exist in the app: ${stale.join(", ")}.\n` +
        "Delete them -- an allowlist that only grows stops meaning anything.",
    );
    process.exitCode = 1;
  }
  if (findings.length === 0 && stale.length === 0) {
    console.log("E2E selector ratchet passed (0 selectors missing from the app).");
  }
}
