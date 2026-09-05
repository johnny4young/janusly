import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { initI18n } from '../i18n'
import { bootstrapTestCatalogs } from './i18n-bootstrap'

await bootstrapTestCatalogs()

beforeEach(() => {
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

afterEach(() => {
  cleanup()
})
