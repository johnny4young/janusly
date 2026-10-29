import { expect, test, vi } from 'vitest'

import { api } from '../api'

vi.mock('../api', () => ({ api: vi.fn() }))

test('loads module mocks while request interception is confirmed live', async () => {
  expect(vi.isMockFunction(api)).toBe(true)
  const response = await fetch('/__janusly_interception_probe__', { cache: 'no-store' })
  expect(response.headers.get('x-interception-probe')).toBe('1')
})
