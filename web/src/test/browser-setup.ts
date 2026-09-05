import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { initI18n } from '../i18n'
import { bootstrapTestCatalogs } from './i18n-bootstrap'
import '../index.css'

await bootstrapTestCatalogs()

beforeEach(() => {
  // Reset to English between tests so locale-mutating tests don't leak state.
  initI18n('en')
  // Clear the persisted locale so each switcher test starts from 'system'.
  try { window.localStorage.removeItem('janusly:locale') } catch { /* ignore */ }
})

// Real Chromium ships crypto.randomUUID natively, so unlike the jsdom setup
// we don't polyfill it. Cleanup after every test keeps mounted React Flow
// instances from leaking pointer handlers between cases.
afterEach(() => {
  cleanup()
})
