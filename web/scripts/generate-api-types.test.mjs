import assert from 'node:assert/strict'
import test from 'node:test'

import { dataSchemaFor, generate, payloadComponents, schemaToType } from './generate-api-types.mjs'

const envelope = {
  V1Envelope: { type: 'object', properties: { apiVersion: { const: 'v1' } } },
  V1ErrorEnvelope: { type: 'object', properties: { error: { type: 'object' } } },
}

function operation(data, extra = {}) {
  return {
    summary: 'probe',
    responses: {
      200: {
        content: {
          'application/json': {
            schema: {
              allOf: [
                { $ref: '#/components/schemas/V1Envelope' },
                { type: 'object', properties: { data } },
              ],
            },
          },
        },
      },
      default: { content: { 'application/json': { schema: { $ref: '#/components/schemas/V1ErrorEnvelope' } } } },
    },
    ...extra,
  }
}

function spec(paths, schemas = {}) {
  return { openapi: '3.1.0', paths, components: { schemas: { ...envelope, ...schemas } } }
}

test('emits one named type per payload component and references it by name', () => {
  const output = generate(spec({
    '/things': {
      get: operation({ type: 'array', items: { $ref: '#/components/schemas/Thing' } }),
      post: operation({ $ref: '#/components/schemas/Thing' }, {
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ThingInput' } } } },
      }),
    },
  }, {
    Thing: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'status'],
      properties: {
        id: { type: 'string' },
        status: { $ref: '#/components/schemas/ThingStatus' },
        note: { type: ['string', 'null'] },
      },
    },
    ThingStatus: { type: 'string', enum: ['open', 'closed'] },
    ThingInput: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  }))

  assert.match(output, /^export type Thing = \{\n {2}"id": string\n {2}"status": ThingStatus\n {2}"note"\?: string \| null\n\}$/m)
  assert.match(output, /^export type ThingStatus = "open" \| "closed"$/m)
  assert.match(output, /^ {2}"GET \/things": Thing\[\]$/m)
  assert.match(output, /^ {2}"POST \/things": Thing$/m)
  assert.match(output, /interface ApiRequests \{[^}]*"POST \/things": ThingInput\n/)
  assert.doesNotMatch(output, /export type V1Envelope/)
  assert.doesNotMatch(output.slice(output.indexOf('export type Thing ')), /\bunknown\b/)
})

test('maps the error envelope to the normalized browser error', () => {
  assert.equal(schemaToType({ $ref: '#/components/schemas/V1ErrorEnvelope' }), 'BrowserApiError')
})

test('an unresolved or foreign $ref fails loudly instead of becoming unknown', () => {
  assert.throws(
    () => generate(spec({ '/x': { get: operation({ $ref: '#/components/schemas/Missing' }) } })),
    /Missing/,
  )
  assert.throws(
    () => payloadComponents(spec({}, { Remote: { $ref: 'https://example.com/schema.json' } })),
    /unsupported \$ref/,
  )
})

test('rejects recursive components with the cycle path', () => {
  assert.throws(
    () => payloadComponents(spec({}, {
      Tree: { type: 'object', properties: { children: { type: 'array', items: { $ref: '#/components/schemas/Node' } } } },
      Node: { type: 'object', properties: { tree: { $ref: '#/components/schemas/Tree' } } },
    })),
    /component reference cycle: Node -> Tree -> Node/,
  )
})

test('rejects component names that would shadow the generated API surface', () => {
  assert.throws(() => payloadComponents(spec({}, { ApiResponses: { type: 'string' } })), /not a usable TypeScript type name/)
  assert.throws(() => payloadComponents(spec({}, { 'lower-case': { type: 'string' } })), /not a usable TypeScript type name/)
})

test('dataSchemaFor unwraps the v1 envelope and keeps a component ref intact', () => {
  assert.deepEqual(dataSchemaFor(operation({ $ref: '#/components/schemas/Thing' })), { $ref: '#/components/schemas/Thing' })
})
