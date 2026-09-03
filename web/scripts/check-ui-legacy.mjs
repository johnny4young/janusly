/**
 * Reject every production owner of Janusly's retired pre-semantic form/action
 * classes. New UI must use components/ui; there is deliberately no baseline
 * or allowance list to grow back.
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

export function legacyUiViolations(actual) {
  return Object.entries(actual).flatMap(([file, classNames]) => (
    classNames.map(className => `legacy class .${className} in ${file}`)
  ))
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMainModule()) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const sourceRoot = path.join(repositoryRoot, 'src')
  const actual = collectLegacyUiOwners(sourceRoot)
  const violations = legacyUiViolations(actual)
  if (violations.length > 0) {
    console.error('UI legacy guard failed:')
    for (const violation of violations) console.error(`  ${violation}`)
    console.error('Migrate every usage to components/ui; legacy allowances are not supported.')
    process.exitCode = 1
  } else {
    console.log('UI legacy guard passed (0 production owners, 0 references).')
  }
}
