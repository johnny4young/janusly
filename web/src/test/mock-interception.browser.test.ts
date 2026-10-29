import { expect, test, vi } from 'vitest'

import { probeTarget } from './mock-interception-fixture'

vi.mock('./mock-interception-fixture', () => ({ probeTarget: () => 'mocked' }))

// The Playwright provider must confirm request interception through this route
// before a module mock applies, or a mocked import can load the real module.
test('loads module mocks while request interception is confirmed live', async () => {
  expect(probeTarget()).toBe('mocked')
  const response = await fetch('/__vitest_interception_probe__', { cache: 'no-store' })
  expect(response.headers.get('x-vitest-probe')).toBe('1')
})
