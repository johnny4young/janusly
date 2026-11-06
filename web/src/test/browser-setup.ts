import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'
import { cleanup, configure } from '@testing-library/react'
import { initI18n } from '../i18n'
import { bootstrapTestCatalogs } from './i18n-bootstrap'
import '../index.css'

await bootstrapTestCatalogs()

// Layout tests measure text, so the shipped face must be in place before the first render.
if ((await document.fonts.load('16px "Inter Tight"')).length === 0) throw new Error('Inter Tight did not load')
await document.fonts.ready

// `findBy*` waits on real lazy chunks here. The 1 s default fails on a busy host
// with no product fault; a failing assertion still fails, only later.
configure({ asyncUtilTimeout: 5_000 })

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
