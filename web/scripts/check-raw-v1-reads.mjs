/**
 * Reject raw `api('/v1-read-path')` calls in production code.
 *
 * Every path in `V1_READ_PATHS` has a typed operation in
 * `src/lib/api-types.generated.ts` and a `contractApi()` entry point. A raw
 * `api()` call on one of those paths bypasses the contract: the response is
 * cast instead of typed, and a manifest that drifts from the handler goes
 * unnoticed until a component dereferences a field that is not there.
 *
 * Used by: `pnpm lint` and `scripts/check-raw-v1-reads.test.mjs`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Extract the V1_READ_PATHS values from the TypeScript source without a TS toolchain. */
export function readV1ReadPaths(contractSource) {
  const block = contractSource.match(/export const V1_READ_PATHS = \{([\s\S]*?)\} as const/)
  if (!block) throw new Error('V1_READ_PATHS block not found in api-contract.ts')
  const paths = []
  for (const match of block[1].matchAll(/:\s*"([^"]+)"/g)) paths.push(match[1])
  if (paths.length === 0) throw new Error('V1_READ_PATHS is empty')
  return paths
}

/**
 * Find `api(` calls whose first argument is a string or template literal that
 * begins with one of the v1 read paths (exactly, or followed by `?`). Path
 * templates such as `/recovery/cases/{caseId}` are matched by their static
 * prefix up to the first `{`.
 */
export function rawV1ReadCalls(source, readPaths) {
  const findings = []
  const prefixes = readPaths.map((route) => route.split('{')[0])
  const callPattern = /\bapi\(\s*(['"`])([^'"`$]*)/g
  for (const match of source.matchAll(callPattern)) {
    const literal = match[2]
    const pathname = literal.split('?')[0]
    const hit = readPaths.includes(pathname)
      || prefixes.some((prefix, index) => readPaths[index].includes('{') && pathname.startsWith(prefix))
    if (!hit) continue
    const line = source.slice(0, match.index).split('\n').length
    findings.push({ line, path: literal })
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

/** The transport and the contract layer are the two places allowed to build raw requests. */
function isExempt(relative) {
  return relative === 'api.ts' || relative.startsWith('lib/')
}

export function collectRawV1Reads(srcRoot, readPaths) {
  const violations = []
  for (const file of listFiles(srcRoot)) {
    const relative = path.relative(srcRoot, file).split(path.sep).join('/')
    if (isExempt(relative)) continue
    const source = fs.readFileSync(file, 'utf8')
    for (const finding of rawV1ReadCalls(source, readPaths)) {
      violations.push({ file: relative, ...finding })
    }
  }
  return violations
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const srcRoot = path.resolve(here, '../src')
  const readPaths = readV1ReadPaths(fs.readFileSync(path.join(srcRoot, 'lib/api-contract.ts'), 'utf8'))
  const violations = collectRawV1Reads(srcRoot, readPaths)
  if (violations.length > 0) {
    console.error('Raw api() reads on v1 contract paths — use contractApi() so the response is typed:')
    for (const violation of violations) {
      console.error(`  src/${violation.file}:${violation.line}  api('${violation.path}')`)
    }
    process.exit(1)
  }
  console.log(`v1 read ratchet passed (${readPaths.length} contract paths, 0 raw reads).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
