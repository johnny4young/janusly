/**
 * Reject internal planning references from the tracked public repository.
 *
 * Used by: root `pnpm lint` and `scripts/check-public-repo-hygiene.test.mjs`.
 * The ignore file and this check's own fixtures are excluded because they must
 * name the forbidden patterns in order to enforce them.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const EXCLUDED_FILES = new Set([
  ".gitignore",
  "scripts/check-public-repo-hygiene.mjs",
  "scripts/check-public-repo-hygiene.test.mjs",
]);

const RULES = [
  {
    label: "internal work item",
    pattern: /\b(?:ENG|RF|Q|M|R|S|W|E|X|A|B|P|O)-\d{2,4}(?:-followup)?\b/g,
  },
  {
    label: "private planning path",
    pattern: /(?:docs\/(?:ROADMAP|PLAN)\.md|docs\/(?:private|proposals)\/|\.planning\/)/g,
  },
];

/** Return one violation per matching line so lint output stays actionable. */
export function scanPublicContent(file, content) {
  if (EXCLUDED_FILES.has(file)) return [];

  const violations = [];
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    for (const { label, pattern } of RULES) {
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (match) {
        violations.push({ file, line: index + 1, label, match: match[0] });
      }
    }
  }
  return violations;
}

/** Read the current Git index so ignored local planning is never inspected. */
export function listTrackedFiles() {
  try {
    return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
  } catch (error) {
    throw new Error(
      "check-public-repo-hygiene needs a git checkout with `git` on PATH: it reads the tracked file list via `git ls-files`. " +
        "Run it from inside the repository (source tarballs and git-less environments cannot be scanned).",
      { cause: error },
    );
  }
}

export function checkTrackedFiles(files = listTrackedFiles()) {
  return files.flatMap((file) => {
    try {
      return scanPublicContent(file, readFileSync(file, "utf8"));
    } catch (error) {
      // `git ls-files` describes the index. During a legitimate unstaged
      // deletion, the path remains indexed but no longer exists in the working
      // tree; there is no public content left to inspect.
      if (error?.code === "EISDIR" || error?.code === "ENOENT") return [];
      throw error;
    }
  });
}

function main() {
  const violations = checkTrackedFiles();
  if (violations.length === 0) {
    process.stdout.write("Public repository hygiene check passed.\n");
    return;
  }

  process.stderr.write("Tracked public files contain internal planning references:\n");
  for (const violation of violations) {
    process.stderr.write(
      `  ${violation.file}:${violation.line} ${violation.label}: ${violation.match}\n`,
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
