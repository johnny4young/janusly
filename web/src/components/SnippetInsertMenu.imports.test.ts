import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('imports snippet insertion without constructing the unused built-in recipe index', async () => {
  const NativeMap = Map
  vi.stubGlobal('Map', new Proxy(NativeMap, {
    construct(target, args, newTarget) {
      const entries: unknown = args[0]
      if (Array.isArray(entries) && entries.length > 0 && entries.every(entry =>
        Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].startsWith('builtin:'))) {
        throw new Error('Unused built-in recipe index initialized by UI import')
      }
      return Reflect.construct(target, args, newTarget)
    },
  }))
  await expect(import('./SnippetInsertMenu')).resolves.toHaveProperty('SnippetInsertMenu')
})
