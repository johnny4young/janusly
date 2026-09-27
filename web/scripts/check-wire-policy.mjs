// Reject server policy (limits, page sizes, ranges) copied into wire readers:
// a numeric literal other than 0, 1 or -1 needs `// wire-policy: <reason>` on
// its own line or alone on the line above.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync, visitorKeys } from "oxc-parser";

export const WIRE_READERS = [
  "src/lib/list-contract.ts",
  "src/lib/run-status-contract.ts",
  "src/lib/dead-letter-contract.ts",
  "src/lib/recovery-patch-contract.ts",
  "src/lib/recovery-case-contract.ts",
  "src/lib/authoring-contract.ts",
  "src/lib/health-delta.ts",
  "src/lib/ai-evidence-runtime.ts",
  "src/recovery-home-sections.ts",
  "src/components/WorkflowRolloutPanel.tsx",
  "src/components/WorkflowRecoveryQualification.tsx",
];

const ALLOWED = new Set([0, 1]);
const MARKER = /^\s*wire-policy:(.*)$/;

function lineOf(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

/** Lines exempted by `// wire-policy: <reason>` comments; a marker without a reason is an error. */
function exemptLines(source, comments) {
  const lines = source.split("\n");
  const exempt = new Set();
  const errors = [];
  for (const comment of comments) {
    // JSX only admits block comments, so both forms carry the marker.
    const marker = comment.value.replace(/\s*\*?\s*$/, "").match(MARKER);
    if (!marker) continue;
    const line = lineOf(source, comment.start);
    if (marker[1].trim() === "") {
      errors.push({ line, message: "wire-policy marker needs a reason" });
      continue;
    }
    exempt.add(line);
    // Standalone, or a JSX `{/* ... */}` expression alone on its line.
    const before = lines[line - 1].slice(0, comment.start - (source.lastIndexOf("\n", comment.start - 1) + 1));
    const standalone = /^\s*\{?\s*$/.test(before);
    if (!standalone) continue;
    exempt.add(line + 1);
  }
  return { exempt, errors };
}

/** Unannotated numeric literals other than 0, 1 and -1 in one source file. */
export function wirePolicyLiterals(source, fileName = "source.ts") {
  const parsed = parseSync(fileName, source, { range: true });
  if (parsed.errors.length > 0) throw new Error(`Unable to inspect ${fileName}: ${parsed.errors[0].message}`);
  const { exempt, errors } = exemptLines(source, parsed.comments);
  const findings = errors.map((error) => ({ ...error, literal: null }));

  function visit(node) {
    if (node.type === "Literal" && (typeof node.value === "number" || typeof node.value === "bigint")) {
      const line = lineOf(source, node.start);
      if (!ALLOWED.has(Number(node.value)) && !exempt.has(line)) {
        findings.push({ line, literal: source.slice(node.start, node.end), message: "numeric literal" });
      }
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach((item) => item && visit(item));
      else if (child && typeof child === "object") visit(child);
    }
  }

  visit(parsed.program);
  return findings.sort((left, right) => left.line - right.line);
}

export function collectWirePolicyLiterals(webRoot, files = WIRE_READERS) {
  const violations = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(webRoot, file), "utf8");
    for (const finding of wirePolicyLiterals(source, file)) violations.push({ file, ...finding });
  }
  return violations;
}

function main() {
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const violations = collectWirePolicyLiterals(webRoot);
  if (violations.length > 0) {
    console.error("Server policy in wire readers — let the generated guard own shape, or annotate `// wire-policy: <reason>`:");
    for (const violation of violations) {
      console.error(`  ${violation.file}:${violation.line}  ${violation.literal ?? ""} ${violation.message}`.trimEnd());
    }
    process.exit(1);
  }
  console.log(`wire policy ratchet passed (${WIRE_READERS.length} readers, 0 unannotated literals).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
