import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'
import { act, cleanup } from '@testing-library/react'
import { initI18n } from '../i18n'
import { bootstrapTestCatalogs } from './i18n-bootstrap'

await bootstrapTestCatalogs()
const { __resetBumpCoalesceForTests } = await import('../store')

beforeEach(() => {
  __resetBumpCoalesceForTests()
  // Reset to English between tests so locale-mutating tests don't leak.
  initI18n('en')
})

if (typeof globalThis.crypto?.randomUUID !== 'function') {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      ...globalThis.crypto,
      randomUUID: () => 'test-' + Math.random().toString(36).slice(2, 10),
    },
  })
}

afterEach(async () => {
  await act(async () => { cleanup() })
  // Zustand state restoration cannot cancel the module-owned debounce timer.
  // A previous mutation must not invalidate the next fixture's fresh reads.
  __resetBumpCoalesceForTests()
})
