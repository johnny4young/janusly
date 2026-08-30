/**
 * Freeze the exact production owners of Janusly's pre-semantic form/action
 * classes. New UI must use components/ui; migrations deliberately shrink the
 * checked-in baseline with `node scripts/check-ui-legacy.mjs --write-baseline`.
 *
 * Used by: `pnpm lint` and `scripts/check-ui-legacy.test.mjs`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractTypeScriptClassReferences } from './check-css-classes.mjs'

const LEGACY_EXACT_CLASSES = new Set([
  'field-label',
  'text-field',
  'we-field',
  'we-fieldset',
])

const LEGACY_CLASS_PREFIXES = [
  'command-button',
  'text-field--',
  'we-btn',
  'we-button',
]

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

export function isLegacyUiClass(className) {
  return LEGACY_EXACT_CLASSES.has(className)
    || LEGACY_CLASS_PREFIXES.some((prefix) => (
      className === prefix || className.startsWith(prefix.endsWith('-') ? prefix : `${prefix}-`)
    ))
}

export function collectLegacyUiOwners(sourceRoot) {
  const owners = {}
  for (const file of listFiles(sourceRoot)) {
    const source = fs.readFileSync(file, 'utf8')
    const references = extractTypeScriptClassReferences(source, file)
    const legacy = Array.from(references.classes).filter(isLegacyUiClass).sort()
    if (legacy.length > 0) owners[path.relative(sourceRoot, file)] = legacy
  }
  return Object.fromEntries(Object.entries(owners).sort(([left], [right]) => left.localeCompare(right)))
}

export function compareLegacyUiBaseline(actual, baseline) {
  const violations = []
  const files = new Set([...Object.keys(actual), ...Object.keys(baseline)])
  for (const file of Array.from(files).sort()) {
    const actualClasses = new Set(actual[file] ?? [])
    const baselineClasses = new Set(baseline[file] ?? [])
    for (const className of actualClasses) {
      if (!baselineClasses.has(className)) violations.push(`new legacy class .${className} in ${file}`)
    }
    for (const className of baselineClasses) {
      if (!actualClasses.has(className)) violations.push(`stale baseline class .${className} in ${file}`)
    }
  }
  return violations
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMainModule()) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const sourceRoot = path.join(repositoryRoot, 'src')
  const baselinePath = path.join(repositoryRoot, 'scripts', 'ui-legacy-baseline.json')
  const actual = collectLegacyUiOwners(sourceRoot)

  if (process.argv.includes('--write-baseline')) {
    fs.writeFileSync(baselinePath, `${JSON.stringify(actual, null, 2)}\n`)
    console.log(`UI legacy baseline updated (${Object.keys(actual).length} production owners).`)
  } else {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
    const violations = compareLegacyUiBaseline(actual, baseline)
    if (violations.length > 0) {
      console.error('UI legacy ratchet failed:')
      for (const violation of violations) console.error(`  ${violation}`)
      console.error('Migrate new usage to components/ui, or shrink the baseline after an intentional migration.')
      process.exitCode = 1
    } else {
      console.log(`UI legacy ratchet passed (${Object.keys(actual).length} frozen production owners).`)
    }
  }
}
