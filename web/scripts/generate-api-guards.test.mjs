import assert from 'node:assert/strict'
import fs from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { generateGuards, operationStem } from './generate-api-guards.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const ref = (name) => ({ $ref: `#/components/schemas/${name}` })

function operation(operationId, data) {
  return {
    operationId,
    summary: 'probe',
    responses: {
      200: {
        content: {
          'application/json': {
            schema: { allOf: [ref('V1Envelope'), { type: 'object', properties: { data } }] },
          },
        },
      },
      default: { content: { 'application/json': { schema: ref('V1ErrorEnvelope') } } },
    },
  }
}

function spec(paths, schemas) {
  return {
    openapi: '3.1.0',
    paths,
    components: { schemas: { V1Envelope: { type: 'object' }, V1ErrorEnvelope: { type: 'object' }, ...schemas } },
  }
}

// Compile every emitted module with the real guards.ts primitives, mirroring
// the src/lib layout so relative imports resolve, and merge their exports.
async function load(document, t) {
  const files = generateGuards(document)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'janusly-api-guards-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const guards = fs.readFileSync(path.join(here, '../src/lib/guards.ts'), 'utf8')
  fs.writeFileSync(path.join(dir, 'guards.mjs'), stripTypeScriptTypes(guards))
  const loaded = {}
  const written = []
  for (const [file, source] of files) {
    const target = path.join(dir, 'api-guards', file.replace(/\.ts$/, '.mjs'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, stripTypeScriptTypes(source).replace(/from "(\.[^"]+)"/g, 'from "$1.mjs"'))
    written.push(target)
  }
  for (const target of written) Object.assign(loaded, await import(pathToFileURL(target).href))
  return { files, source: [...files.values()].join('\n'), guards: loaded }
}

const components = {
  Status: { type: 'string', enum: ['open', 'closed'], description: 'annotated' },
  Opaque: {},
  Item: {
    type: 'object',
    title: 'An item',
    additionalProperties: false,
    required: ['id', 'count', 'status', 'payload', 'kind', 'note'],
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 3, format: 'uuid' },
      count: { type: 'integer', minimum: 0, maximum: 2 },
      ratio: { type: 'number' },
      status: ref('Status'),
      payload: ref('Opaque'),
      kind: { const: 'item' },
      note: { type: ['string', 'null'] },
      tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 1 },
      labels: { type: 'object', additionalProperties: { type: 'string' } },
      meta: {
        type: 'object',
        additionalProperties: { type: ['number', 'boolean'] },
        properties: { version: { type: 'string' } },
      },
      open: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
      raw: { type: 'object' },
      any: { type: 'array' },
    },
  },
  Either: {
    oneOf: [
      { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { const: true } } },
      { type: 'object', additionalProperties: false, required: ['error'], properties: { error: { type: 'string' } } },
    ],
  },
  Both: { allOf: [{ type: 'object', required: ['a'], properties: { a: { type: 'boolean' } } }, { type: 'object', required: ['b'] }] },
  MaybeItem: { anyOf: [ref('Item'), { type: 'null' }] },
}

const document = spec({
  '/items': {
    get: operation('get_v1_items', { type: 'array', items: ref('Item'), maxItems: 1 }),
    post: operation('post_v1_items', ref('Either')),
  },
  '/items/{id}': { get: operation('get_v1_items_id', ref('MaybeItem')) },
  '/both': { get: operation('get_v1_both', ref('Both')) },
}, components)

const item = {
  id: 'abc', count: 1, status: 'open', payload: { anything: [1] }, kind: 'item', note: null,
}

test('names one guard per component and per operation without the version segment', async (t) => {
  const { files, source, guards } = await load(document, t)
  for (const name of ['isStatus', 'isOpaque', 'isItem', 'isEither', 'isBoth', 'isMaybeItem',
    'isGetItemsResponse', 'isPostItemsResponse', 'isGetItemsIdResponse', 'isGetBothResponse']) {
    assert.equal(typeof guards[name], 'function', name)
  }
  assert.match(source, /export function isItem\(value: unknown\): value is Api\.Item \{/)
  assert.match(source, /export function isGetItemsResponse\(value: unknown\): value is Api\.ApiResponses\["GET \/items"\] \{/)
  assert.doesNotMatch(source, /^(?:const|let|var) /m, 'no module-level state')
  assert.deepEqual([...files.keys()].sort(), [
    'components/Both.ts', 'components/Either.ts', 'components/Item.ts', 'components/MaybeItem.ts',
    'components/Opaque.ts', 'components/Status.ts', 'operations/GetBoth.ts', 'operations/GetItems.ts',
    'operations/GetItemsId.ts', 'operations/PostItems.ts',
  ])
  assert.equal(operationStem({ operationId: 'get_v1_recovery_my-wins' }, 'k'), 'GetRecoveryMyWins')
})

test('enforces types, enums, consts, nullability, required and closed keys', async (t) => {
  const { guards: { isItem } } = await load(document, t)
  assert.equal(isItem(item), true)
  assert.equal(isItem({ ...item, ratio: 0.5, note: 'n', tags: ['a'], labels: { a: 'b' }, meta: { version: '1', x: 1, y: true } }), true)
  const rejected = {
    'extra key': { ...item, extra: 1 },
    'missing required': (({ id: _id, ...rest }) => rest)(item),
    'missing opaque required': (({ payload: _payload, ...rest }) => rest)(item),
    'wrong enum': { ...item, status: 'pending' },
    'wrong const': { ...item, kind: 'other' },
    'fractional integer': { ...item, count: 1.5 },
    'unsafe integer': { ...item, count: 2 ** 53 },
    'infinite number': { ...item, ratio: Infinity },
    'undefined nullable': { ...item, note: undefined },
    'wrong item type': { ...item, tags: [1] },
    'wrong map value': { ...item, labels: { a: 1 } },
    'wrong declared key in map': { ...item, meta: { version: 1 } },
    'wrong extra key in map': { ...item, meta: { x: 'no' } },
    'open object missing required': { ...item, open: {} },
    'array for object': { ...item, raw: [] },
    'not an array': { ...item, any: {} },
    'array value': [item],
    null: null,
  }
  for (const [name, value] of Object.entries(rejected)) assert.equal(isItem(value), false, name)
  assert.equal(isItem({ ...item, open: { x: 1, extra: true }, raw: { a: 1 }, any: [null] }), true, 'open objects keep extra keys')
})

test('does not enforce server policy bounds', async (t) => {
  const { guards: { isGetItemsResponse } } = await load(document, t)
  const oversized = { ...item, id: 'far longer than three characters', count: 99, tags: ['a', 'b', 'c'] }
  assert.equal(isGetItemsResponse([oversized, oversized]), true)
  assert.equal(isGetItemsResponse([{ ...oversized, id: '' }]), true)
})

test('combinators and references compose through component guards', async (t) => {
  const { guards } = await load(document, t)
  assert.equal(guards.isPostItemsResponse({ ok: true }), true)
  assert.equal(guards.isPostItemsResponse({ error: 'x' }), true)
  assert.equal(guards.isPostItemsResponse({ ok: false }), false)
  assert.equal(guards.isPostItemsResponse({ ok: true, error: 'x' }), false)
  assert.equal(guards.isGetItemsIdResponse(null), true)
  assert.equal(guards.isGetItemsIdResponse(item), true)
  assert.equal(guards.isGetItemsIdResponse(undefined), false)
  assert.equal(guards.isGetBothResponse({ a: true, b: null }), true)
  assert.equal(guards.isGetBothResponse({ a: true }), false)
  assert.equal(guards.isGetBothResponse({ a: 'yes', b: 1 }), false)
  assert.equal(guards.isOpaque(undefined), true)
})

test('rejects unsupported keywords with the schema path', () => {
  const broken = (schema) => spec({ '/x': { get: operation('get_v1_x', ref('Broken')) } }, { Broken: schema })
  assert.throws(() => generateGuards(broken({ type: 'object', properties: { a: { type: 'string', pattern: '^a' } } })),
    /#\/components\/schemas\/Broken\/properties\/a: unsupported keyword "pattern"/)
  assert.throws(() => generateGuards(broken({ type: 'string', not: { const: 'a' } })), /unsupported keyword "not"/)
  assert.throws(() => generateGuards(broken({ type: 'array', items: [{ type: 'string' }] })), /tuple items are not supported/)
  assert.throws(() => generateGuards(broken({ properties: { a: { type: 'string' } } })), /object and array keywords need a type/)
  assert.throws(() => generateGuards(broken({ type: 'date' })), /unsupported type "date"/)
  assert.throws(() => generateGuards(broken({ $ref: '#/components/schemas/Missing' })), /names no component/)
  assert.throws(() => generateGuards(broken({ type: 'object', properties: { ['__proto__']: { type: 'string' } } })), /__proto__/)
})

test('each module imports only what it references, with no barrel', () => {
  const files = generateGuards(document)
  assert.equal(files.get('operations/GetItems.ts').includes('import { isItem } from "../components/Item"'), true)
  assert.doesNotMatch(files.get('operations/GetItems.ts'), /Status|Either/)
  assert.match(files.get('components/MaybeItem.ts'), /import \{ isItem \} from "\.\/Item"/)
  assert.match(files.get('components/Item.ts'), /import \{ isStatus \} from "\.\/Status"/)
  assert.doesNotMatch(files.get('components/Item.ts'), /from "\.\/Opaque"/, 'an opaque reference compiles to isAny')
  assert.match(files.get('components/Status.ts'), /import \{ literal \} from "\.\.\/\.\.\/guards"/)
  assert.equal([...files.keys()].some((file) => /index\.ts$/.test(file)), false)
})

test('rejects empty or contradictory literal sets with the schema path', () => {
  const broken = (schema) => spec({ '/x': { get: operation('get_v1_x', ref('Broken')) } }, { Broken: schema })
  assert.throws(() => generateGuards(broken({ type: 'string', const: 5 })),
    /#\/components\/schemas\/Broken: literal 5 contradicts type "string"/)
  assert.throws(() => generateGuards(broken({ enum: ['a'], const: 'b' })), /Broken: const and enum admit no value/)
  assert.throws(() => generateGuards(broken({ type: 'string', enum: [] })), /Broken: const and enum admit no value/)
  assert.throws(() => generateGuards(broken({ type: 'object', properties: { a: { type: 'integer', enum: [1, 1.5] } } })),
    /Broken\/properties\/a: literal 1.5 contradicts type "integer"/)
  assert.throws(() => generateGuards(broken({ type: ['string'], enum: ['a', null] })), /literal null contradicts/)
  assert.doesNotThrow(() => generateGuards(broken({ type: ['string', 'null'], enum: ['a', null] })))
})

test('refuses module names that collide on a case-insensitive file system', () => {
  const document = spec({ '/x': { get: operation('get_v1_x', ref('Item')) } }, { Item: { type: 'string' }, ITEM: { type: 'string' } })
  assert.throws(() => generateGuards(document), /case-insensitive/)
})
