import { expect, test, vi } from 'vitest'

import { probeTarget } from './mock-interception-fixture'

vi.mock('./mock-interception-fixture', () => ({ probeTarget: () => 'mocked' }))

test('loads module mocks while request interception is confirmed live', async () => {
  expect(probeTarget()).toBe('mocked')
  const response = await fetch('/__janusly_interception_probe__', { cache: 'no-store' })
  expect(response.headers.get('x-interception-probe')).toBe('1')
})
