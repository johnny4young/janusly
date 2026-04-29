import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Real Chromium ships crypto.randomUUID natively, so unlike the jsdom setup
// we don't polyfill it. Cleanup after every test keeps mounted React Flow
// instances from leaking pointer handlers between cases.
afterEach(() => {
  cleanup()
})
