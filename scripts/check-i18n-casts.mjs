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
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const webRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
const ts = webRequire("typescript");

function isTranslationCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (ts.isIdentifier(callee) && callee.text === "t")
    || (ts.isPropertyAccessExpression(callee) && callee.name.text === "t");
}

/** Return whether an expression subtree contains a translation lookup. */
function containsTranslationCall(node) {
  if (isTranslationCall(node)) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsTranslationCall(child)) found = true;
  });
  return found;
}

/** Return every translation-derived string assertion in one source string. */
export function findTranslationStringAssertions(source, fileName = "source.tsx") {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings = [];

  function visit(node) {
    if (
      ts.isAsExpression(node)
      && node.type.kind === ts.SyntaxKind.StringKeyword
      && containsTranslationCall(node.expression)
    ) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      findings.push({
        line: position.line + 1,
        column: position.character + 1,
        expression: source.slice(node.getStart(sourceFile), node.getEnd()),
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
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
