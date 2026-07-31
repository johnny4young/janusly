import { describe, expect, it } from 'vitest'
import {
  resolveWebTestWorkerLimit,
  WEB_TEST_WORKER_CEILING,
} from '../../vitest-worker-policy'

describe('web test worker policy', () => {
  it('uses the available host workers below the ceiling', () => {
    expect(resolveWebTestWorkerLimit(1)).toBe(1)
    expect(resolveWebTestWorkerLimit(2)).toBe(2)
  })

  it('bounds high-core hosts without disabling file parallelism', () => {
    expect(resolveWebTestWorkerLimit(8)).toBe(WEB_TEST_WORKER_CEILING)
    expect(resolveWebTestWorkerLimit(14)).toBe(WEB_TEST_WORKER_CEILING)
  })

  it('never returns a non-positive or fractional worker count', () => {
    expect(resolveWebTestWorkerLimit(0)).toBe(1)
    expect(resolveWebTestWorkerLimit(3.9)).toBe(3)
  })
})
