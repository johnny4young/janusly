import { describe, expect, it } from 'vitest'
import { evaluateJsonJq, parseJsonJqQuery } from './json-jq'

describe('evaluateJsonJq', () => {
  const source = {
    user: { name: 'Ada', roles: ['admin', 'editor'] },
    users: [
      { email: 'a@example.com', profile: { active: true } },
      { email: 'b@example.com', profile: { active: false } },
    ],
    'dash-key': { value: 42 },
  }

  it('returns identity for dot', () => {
    expect(evaluateJsonJq(source, '.')).toEqual(source)
  })

  it('walks dotted object properties', () => {
    expect(evaluateJsonJq(source, '.user.name')).toBe('Ada')
  })

  it('walks bracket object properties', () => {
    expect(evaluateJsonJq(source, '.["dash-key"].value')).toBe(42)
  })

  it('walks array indexes including negative indexes', () => {
    expect(evaluateJsonJq(source, '.user.roles[0]')).toBe('admin')
    expect(evaluateJsonJq(source, '.user.roles[-1]')).toBe('editor')
  })

  it('projects arrays through pipeline stages', () => {
    expect(evaluateJsonJq(source, '.users[] | .email')).toEqual([
      'a@example.com',
      'b@example.com',
    ])
  })

  it('returns null for projections with no results', () => {
    expect(evaluateJsonJq(source, '.user.name[]')).toBeNull()
  })

  it('rejects unsupported selectors', () => {
    expect(() => parseJsonJqQuery('user.name')).toThrow(/must start/)
    expect(() => parseJsonJqQuery('.users[foo]')).toThrow(/integer indexes or quoted keys/)
    expect(() => parseJsonJqQuery('.users[] |')).toThrow(/at least one selector stage/)
    expect(() => parseJsonJqQuery('.user-name')).toThrow(/bracket notation/)
    expect(() => parseJsonJqQuery('.users]')).toThrow(/closing bracket/)
    expect(() => parseJsonJqQuery('.users[0')).toThrow(/not closed/)
  })
})
