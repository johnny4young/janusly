/**
 * Reject raw `api()` calls that bypass a typed contract operation.
 *
 * Every path in `V1_READ_PATHS`, and every operation in `contract/openapi.json`
 * (reads and mutations, literal or templated paths), has a typed
 * `contractApi()` entry point and a generated response guard. A raw `api()`
 * call casts the response instead, so a manifest that drifts from the handler
 * goes unnoticed until a component dereferences a field that is not there.
 * A deliberate exception carries `// raw-api: <reason>` on its line or the
 * line above; calls that predate the operation check are listed in
 * `RAW_OPERATION_BASELINE`, which may only shrink.
 *
 * Used by: `pnpm lint` and `scripts/check-raw-v1-reads.test.mjs`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync, visitorKeys } from 'oxc-parser'

/** Raw mutation calls that predate the operation check, as `file: [operation, ...]`. */
export const RAW_OPERATION_BASELINE = {
  'components/WorkflowReadinessBadge.tsx': ['POST /workflows/readiness'],
  'components/WorkflowsDashboard.tsx': ['POST /workflows/{id}/resume'],
  'components/recovery-dialog/SimilarRunsCard.tsx': ['GET /runs/semantic-search'],
  'hooks/useRunCommands.ts': [
    'POST /dlq/replay', 'POST /dlq/replay', 'POST /resume', 'POST /resume', 'POST /run/cancel', 'POST /runs/redrive', 'POST /start',
  ],
  'hooks/useWorkflowCommands.ts': ['POST /validate'],
}

/** Extract the V1_READ_PATHS values from the TypeScript source without a TS toolchain. */
export function readV1ReadPaths(contractSource) {
  const block = contractSource.match(/export const V1_READ_PATHS = \{([\s\S]*?)\} as const/)
  if (!block) throw new Error('V1_READ_PATHS block not found in api-contract.ts')
  const paths = []
  for (const match of block[1].matchAll(/:\s*"([^"]+)"/g)) paths.push(match[1])
  if (paths.length === 0) throw new Error('V1_READ_PATHS is empty')
  return paths
}

/** `METHOD /path` keys of every operation in an OpenAPI document. */
export function readManifestOperations(document) {
  const operations = []
  for (const [route, items] of Object.entries(document?.paths ?? {})) {
    for (const method of Object.keys(items)) operations.push(`${method.toUpperCase()} ${route}`)
  }
  if (operations.length === 0) throw new Error('contract/openapi.json lists no operations')
  return operations.sort()
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

function templateMatcher(operation) {
  const [method, route] = operation.split(' ')
  const segments = route.split('/')
  return (candidateMethod, pathname) => {
    if (candidateMethod !== method) return false
    const actual = pathname.split('/')
    return actual.length === segments.length && segments.every((segment, index) => (
      /^\{[^/{}]+\}$/.test(segment) ? actual[index] !== '' : segment === actual[index]
    ))
  }
}

function staticPath(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  // A `${...}` expression stands for one path segment value.
  if (node?.type === 'TemplateLiteral') return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('\u0000')
  return null
}

function requestMethod(options) {
  if (options?.type !== 'ObjectExpression') return 'GET'
  for (const property of options.properties) {
    const key = property.type === 'Property' && (property.key.name ?? property.key.value)
    if (key === 'method' && property.value.type === 'Literal' && typeof property.value.value === 'string') {
      return property.value.value.toUpperCase()
    }
  }
  return 'GET'
}

/** Raw `api()` calls whose method and literal path match a manifest operation. */
export function rawOperationCalls(source, operations, fileName = 'source.tsx') {
  const parsed = parseSync(fileName, source, { range: true })
  if (parsed.errors.length > 0) throw new Error(`Unable to inspect ${fileName}: ${parsed.errors[0].message}`)
  const lines = source.split('\n')
  const annotated = (line) => [line, line - 1].some((index) => /\/\/\s*raw-api:\s*\S/.test(lines[index - 1] ?? ''))
  const matchers = operations.map((operation) => [operation, templateMatcher(operation)])
  const findings = []
  function visit(node) {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'api') {
      const literal = staticPath(node.arguments[0])
      if (literal !== null) {
        const pathname = literal.split('?')[0].replace(/^\/v1(?=\/)/, '').replaceAll('\u0000', 'x')
        const method = requestMethod(node.arguments[1])
        const hit = matchers.find(([, matches]) => matches(method, pathname))
        const line = source.slice(0, node.start).split('\n').length
        if (hit && !annotated(line)) findings.push({ line, operation: hit[0] })
      }
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const child = node[key]
      if (Array.isArray(child)) child.forEach((item) => item && visit(item))
      else if (child && typeof child === 'object') visit(child)
    }
  }
  visit(parsed.program)
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

/**
 * Raw operation calls beyond the baseline, and baseline entries that no longer
 * exist (the list must shrink with the code).
 */
export function collectRawOperationCalls(srcRoot, operations, baseline = RAW_OPERATION_BASELINE) {
  const violations = []
  const seen = new Map()
  for (const file of listFiles(srcRoot)) {
    const relative = path.relative(srcRoot, file).split(path.sep).join('/')
    if (isExempt(relative)) continue
    const findings = rawOperationCalls(fs.readFileSync(file, 'utf8'), operations, relative)
    const allowed = [...(baseline[relative] ?? [])]
    for (const finding of findings) {
      const index = allowed.indexOf(finding.operation)
      if (index === -1) violations.push({ file: relative, ...finding })
      else allowed.splice(index, 1)
    }
    seen.set(relative, allowed)
  }
  const stale = []
  for (const [file, operations] of Object.entries(baseline)) {
    for (const operation of seen.get(file) ?? operations) stale.push({ file, operation })
  }
  return { violations, stale }
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const srcRoot = path.resolve(here, '../src')
  const readPaths = readV1ReadPaths(fs.readFileSync(path.join(srcRoot, 'lib/api-contract.ts'), 'utf8'))
  const operations = readManifestOperations(JSON.parse(fs.readFileSync(path.resolve(here, '../../contract/openapi.json'), 'utf8')))
  const reads = collectRawV1Reads(srcRoot, readPaths)
  const { violations, stale } = collectRawOperationCalls(srcRoot, operations)
  if (reads.length > 0 || violations.length > 0 || stale.length > 0) {
    if (reads.length > 0) console.error('Raw api() reads on v1 contract paths — use contractApi() so the response is typed:')
    for (const violation of reads) console.error(`  src/${violation.file}:${violation.line}  api('${violation.path}')`)
    if (violations.length > 0) console.error('Raw api() calls on manifest operations — use contractApi() with its generated guard, or annotate `// raw-api: <reason>`:')
    for (const violation of violations) console.error(`  src/${violation.file}:${violation.line}  ${violation.operation}`)
    if (stale.length > 0) console.error('RAW_OPERATION_BASELINE lists calls that no longer exist — delete them:')
    for (const entry of stale) console.error(`  src/${entry.file}  ${entry.operation}`)
    process.exit(1)
  }
  const baselined = Object.values(RAW_OPERATION_BASELINE).flat().length
  console.log(`contract call ratchet passed (${readPaths.length} v1 read paths, ${operations.length} operations, 0 raw reads, ${baselined} baselined raw calls).`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
