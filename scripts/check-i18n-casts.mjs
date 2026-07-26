/**
 * Reject vestigial `t(...) as string` assertions in the web source tree.
 *
 * The typed i18n chokepoint already returns `string`. Keeping assertions at
 * call sites hides type drift and adds noise, so this script is a zero-baseline
 * ratchet rather than a warning counter.
 *
 * Used by: root `pnpm lint` and `scripts/check-i18n-casts.test.mjs`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync, visitorKeys } from "oxc-parser";

function isTranslationCall(node) {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  return (callee.type === "Identifier" && callee.name === "t")
    || (
      callee.type === "MemberExpression"
      && !callee.computed
      && callee.property.type === "Identifier"
      && callee.property.name === "t"
    );
}

/** Return whether an expression subtree contains a translation lookup. */
function containsTranslationCall(node) {
  if (isTranslationCall(node)) return true;
  return (visitorKeys[node.type] ?? []).some((key) => {
    const child = node[key];
    if (Array.isArray(child)) return child.some((item) => item && containsTranslationCall(item));
    return child && typeof child === "object" && containsTranslationCall(child);
  });
}

/** Return every translation-derived string assertion in one source string. */
export function findTranslationStringAssertions(source, fileName = "source.tsx") {
  const parsed = parseSync(fileName, source, { range: true });
  if (parsed.errors.length > 0) {
    throw new Error(`Unable to inspect ${fileName}: ${parsed.errors[0].message}`);
  }
  const findings = [];

  function visit(node) {
    if (
      node.type === "TSAsExpression"
      && node.typeAnnotation.type === "TSStringKeyword"
      && containsTranslationCall(node.expression)
    ) {
      const lineStart = source.lastIndexOf("\n", node.start - 1) + 1;
      const line = source.slice(0, lineStart).split("\n").length;
      findings.push({
        line,
        column: node.start - lineStart + 1,
        expression: source.slice(node.start, node.end),
      });
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach((item) => item && visit(item));
      else if (child && typeof child === "object") visit(child);
    }
  }

  visit(parsed.program);
  return findings;
}

/** Walk `.ts` / `.tsx` files recursively without following symlinks. */
export function listTypeScriptFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(absolute));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

export function checkTranslationStringAssertions(root) {
  const findings = [];
  for (const file of listTypeScriptFiles(root)) {
    const source = fs.readFileSync(file, "utf8");
    for (const finding of findTranslationStringAssertions(source, file)) {
      findings.push({ file, ...finding });
    }
  }
  return findings;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sourceRoot = path.join(repositoryRoot, "apps/web/src");
  const findings = checkTranslationStringAssertions(sourceRoot);

  if (findings.length > 0) {
    console.error(`Found ${findings.length} forbidden i18n string assertion(s):`);
    for (const finding of findings) {
      console.error(
        `${path.relative(repositoryRoot, finding.file)}:${finding.line}:${finding.column} ${finding.expression}`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log("i18n cast ratchet passed (0 t(...) as string assertions).");
  }
}
