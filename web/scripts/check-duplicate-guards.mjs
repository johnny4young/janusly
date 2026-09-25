/**
 * Reject a second definition of the shared runtime guards. Every function
 * `src/lib/guards.ts` exports (the record helpers, the nullable/optional
 * string guards, `hasOnlyKeys`, and the primitives the generated guards are
 * composed from) is owned there; a local copy, even with different casing, is
 * how their null handling drifted apart.
 *
 * Used by: `pnpm lint` and `scripts/check-duplicate-guards.test.mjs`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OWNER = 'lib/guards.ts'
const here = path.dirname(fileURLToPath(import.meta.url))

/** The function names a guards module exports. */
export function ownedGuardNames(guardsSource) {
  const names = [...guardsSource.matchAll(/^export function (\w+)/gm)].map((match) => match[1])
  if (names.length === 0) throw new Error(`${OWNER} exports no guards`)
  return names
}

let defaultNames
function realGuardNames() {
  defaultNames ??= ownedGuardNames(fs.readFileSync(path.resolve(here, '../src', OWNER), 'utf8'))
  return defaultNames
}

/** Lines that declare one of the shared guards (compared case-insensitively) as a local function or const. */
export function duplicateGuardDeclarations(source, names = realGuardNames()) {
  const owned = new Map(names.map((name) => [name.toLowerCase(), name]))
  const findings = []
  for (const match of source.matchAll(/^\s*(?:export\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)\b/gm)) {
    const owner = owned.get(match[1].toLowerCase())
    if (!owner) continue
    findings.push({ name: match[1], owner, line: source.slice(0, match.index).split('\n').length })
  }
  return findings
}

function isProductionTypeScript(name) {
  return /\.tsx?$/.test(name) && !/\.(?:test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts')
}

function listFiles(root) {
  const files = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(absolute))
    else if (entry.isFile() && isProductionTypeScript(entry.name)) files.push(absolute)
  }
  return files
}

export function collectDuplicateGuards(srcRoot, names = ownedGuardNames(fs.readFileSync(path.join(srcRoot, OWNER), 'utf8'))) {
  const violations = []
  for (const file of listFiles(srcRoot)) {
    const relative = path.relative(srcRoot, file).split(path.sep).join('/')
    if (relative === OWNER) continue
    for (const finding of duplicateGuardDeclarations(fs.readFileSync(file, 'utf8'), names)) {
      violations.push({ file: relative, ...finding })
    }
  }
  return violations
}

function main() {
  const srcRoot = path.resolve(here, '../src')
  const names = ownedGuardNames(fs.readFileSync(path.join(srcRoot, OWNER), 'utf8'))
  const violations = collectDuplicateGuards(srcRoot, names)
  if (violations.length > 0) {
    console.error('Duplicate runtime guards — import them from src/lib/guards.ts instead:')
    for (const violation of violations) {
      const alias = violation.name === violation.owner ? '' : ` (copy of ${violation.owner})`
      console.error(`  src/${violation.file}:${violation.line}  ${violation.name}${alias}`)
    }
    process.exit(1)
  }
  console.log(`duplicate guard ratchet passed (${names.length} guards live in src/lib/guards.ts only).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
