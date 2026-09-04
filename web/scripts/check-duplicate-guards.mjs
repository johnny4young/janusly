/**
 * Reject a second definition of the runtime shape guards. `src/lib/guards.ts`
 * owns `isRecord`, `asRecord` and `asRecordOrEmpty`; a local copy in a
 * component is how their null handling drifted apart.
 *
 * Used by: `pnpm lint` and `scripts/check-duplicate-guards.test.mjs`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD_NAMES = ['isRecord', 'asRecord', 'asRecordOrEmpty']
const OWNER = 'lib/guards.ts'

/** Lines that declare one of the shared guards as a local function or const. */
export function duplicateGuardDeclarations(source) {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?(?:function|const)\\s+(${GUARD_NAMES.join('|')})\\b`, 'gm')
  const findings = []
  for (const match of source.matchAll(pattern)) {
    findings.push({ name: match[1], line: source.slice(0, match.index).split('\n').length })
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

export function collectDuplicateGuards(srcRoot) {
  const violations = []
  for (const file of listFiles(srcRoot)) {
    const relative = path.relative(srcRoot, file).split(path.sep).join('/')
    if (relative === OWNER) continue
    for (const finding of duplicateGuardDeclarations(fs.readFileSync(file, 'utf8'))) {
      violations.push({ file: relative, ...finding })
    }
  }
  return violations
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const violations = collectDuplicateGuards(path.resolve(here, '../src'))
  if (violations.length > 0) {
    console.error('Duplicate runtime guards — import them from src/lib/guards.ts instead:')
    for (const violation of violations) console.error(`  src/${violation.file}:${violation.line}  ${violation.name}`)
    process.exit(1)
  }
  console.log('duplicate guard ratchet passed (guards live in src/lib/guards.ts only).')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
