import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as generated from './api-guards.generated'

type Schema = Record<string, unknown>
type Operation = { operationId: string; responses: Record<string, { content?: Record<string, { schema?: Schema }> }> }

const document = JSON.parse(readFileSync('../contract/openapi.json', 'utf8')) as {
  paths: Record<string, Record<string, Operation>>
  components: { schemas: Record<string, Schema> }
}
const guards = generated as unknown as Record<string, (value: unknown) => boolean>

function resolve(schema: Schema): Schema {
  const ref = schema.$ref
  return typeof ref === 'string' ? resolve(document.components.schemas[ref.split('/').pop()!]!) : schema
}

function types(schema: Schema): string[] {
  const type = schema.type
  return Array.isArray(type) ? type as string[] : typeof type === 'string' ? [type] : []
}

function acceptsAnything(schema: Schema): boolean {
  return Object.keys(resolve(schema)).every(key => ['description', 'summary', 'title', 'format'].includes(key))
}

// A deterministic value for a schema: every optional property, the first union
// branch, one item per array. `oversize` breaks every server length bound.
function sample(input: Schema, oversize = false): unknown {
  const schema = resolve(input)
  if ('const' in schema) return schema.const
  if (Array.isArray(schema.enum)) return schema.enum[0]
  for (const keyword of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[keyword])) return sample((schema[keyword] as Schema[])[0]!, oversize)
  }
  if (Array.isArray(schema.allOf)) {
    return Object.assign({}, ...(schema.allOf as Schema[]).map(part => sample(part, oversize)))
  }
  const type = types(schema).find(candidate => candidate !== 'null') ?? types(schema)[0]
  switch (type) {
    case 'string': return oversize && typeof schema.maxLength === 'number' ? 'x'.repeat(schema.maxLength + 1) : 'sample'
    case 'integer': return oversize && typeof schema.maximum === 'number' ? schema.maximum + 1 : 1
    case 'number': return oversize && typeof schema.maximum === 'number' ? schema.maximum + 0.5 : 1.5
    case 'boolean': return true
    case 'null': return null
    case 'array': {
      const count = oversize && typeof schema.maxItems === 'number' ? schema.maxItems + 1 : 1
      return schema.items ? Array.from({ length: count }, () => sample(schema.items as Schema, oversize)) : []
    }
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Schema>
      const value: Record<string, unknown> = {}
      for (const [key, property] of Object.entries(properties)) value[key] = sample(property, oversize)
      const additional = schema.additionalProperties
      if (additional && typeof additional === 'object') value.sampleKey = sample(additional as Schema, oversize)
      return value
    }
    default:
      return { opaque: true }
  }
}

function jsonType(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
}

// A JSON value whose type the schema does not admit, or undefined when every type is admitted.
function wrongValue(input: Schema): unknown {
  const admitted = new Set<string>()
  const collect = (node: Schema) => {
    const schema = resolve(node)
    for (const type of types(schema)) admitted.add(type)
    if ('const' in schema) admitted.add(jsonType(schema.const))
    if (Array.isArray(schema.enum)) for (const literal of schema.enum) admitted.add(jsonType(literal))
    for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(schema[keyword])) for (const branch of schema[keyword] as Schema[]) collect(branch)
    }
  }
  collect(input)
  const candidates: [string, unknown][] = [
    ['boolean', true], ['string', 'wrong-type'], ['number', 12345.5], ['array', []], ['object', {}], ['null', null],
  ]
  return candidates.find(([type]) => !admitted.has(type))?.[1]
}

function dataSchema(operation: Operation): Schema | null {
  const schema = operation.responses['200']?.content?.['application/json']?.schema
  const parts = (schema?.allOf ?? []) as Schema[]
  for (const part of parts) {
    const data = (part.properties as Record<string, Schema> | undefined)?.data
    if (data) return data
  }
  return null
}

function guardName(operationId: string): string {
  const parts = operationId.split(/[_-]+/).filter(Boolean)
  if (/^v\d+$/.test(parts[1] ?? '')) parts.splice(1, 1)
  return `is${parts.map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('')}Response`
}

// The object a mutation targets: the payload itself, or the first item of a list.
function target(schema: Schema, value: unknown): { schema: Schema; value: Record<string, unknown> } | null {
  const resolved = resolve(schema)
  for (const keyword of ['oneOf', 'anyOf']) {
    if (Array.isArray(resolved[keyword])) return target((resolved[keyword] as Schema[])[0]!, value)
  }
  if (types(resolved).includes('array') && Array.isArray(value) && value.length > 0) {
    return target(resolved.items as Schema, value[0])
  }
  if (types(resolved).includes('object') && value && typeof value === 'object') {
    return { schema: resolved, value: value as Record<string, unknown> }
  }
  return null
}

const operations = Object.entries(document.paths).flatMap(([path, items]) =>
  Object.entries(items).flatMap(([method, operation]) => {
    const data = dataSchema(operation)
    return data ? [{ key: `${method.toUpperCase()} ${path}`, name: guardName(operation.operationId), data }] : []
  }))

describe('generated operation guards', () => {
  it('cover every operation with a 2xx payload', () => {
    expect(operations.length).toBeGreaterThan(50)
    for (const { key, name } of operations) expect(typeof guards[name], key).toBe('function')
  })

  it('reach a closed object with required keys in every payload, so each break below runs', () => {
    for (const { key, data } of operations) {
      const found = target(data, sample(data))
      expect(found?.schema.additionalProperties, key).toBe(false)
      expect(((found?.schema.required ?? []) as string[]).length, key).toBeGreaterThan(0)
    }
  })

  it.each(operations)('$key accepts its sample and rejects shape breaks', ({ key, name, data }) => {
    const guard = guards[name]!
    const value = sample(data)
    expect(guard(value), `${key} sample`).toBe(true)

    const mutate = (change: (object: Record<string, unknown>) => void) => {
      const copy = structuredClone(value)
      const found = target(data, copy)
      if (!found) return null
      change(found.value)
      return copy
    }
    const found = target(data, structuredClone(value))
    if (!found) return
    const required = (found.schema.required ?? []) as string[]
    const properties = (found.schema.properties ?? {}) as Record<string, Schema>

    if (found.schema.additionalProperties === false) {
      expect(guard(mutate(object => { object.unexpectedWireKey = true })), `${key} extra key`).toBe(false)
    }
    const missing = required[0]
    if (missing !== undefined) {
      expect(guard(mutate(object => { delete object[missing] })), `${key} missing ${missing}`).toBe(false)
    }
    const typed = required.find(entry => properties[entry] && !acceptsAnything(properties[entry]) && wrongValue(properties[entry]) !== undefined)
    if (typed !== undefined) {
      const wrong = wrongValue(properties[typed]!)
      expect(guard(mutate(object => { object[typed] = wrong })), `${key} wrong ${typed}`).toBe(false)
    }
  })

  it('accepts values beyond server length, count and range bounds', () => {
    let bounded = 0
    for (const { key, name, data } of operations) {
      const oversized = sample(data, true)
      if (JSON.stringify(oversized) !== JSON.stringify(sample(data))) bounded += 1
      expect(guards[name]!(oversized), key).toBe(true)
    }
    expect(bounded).toBeGreaterThan(0)
    const runs = operations.find(operation => operation.key === 'GET /runs')!
    const row = (sample(runs.data) as unknown[])[0]
    expect(guards[runs.name]!(Array.from({ length: 201 }, () => row)), 'a page past maxItems').toBe(true)
  })
})
