import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./persistence', () => ({
  getRunNodeStatus: vi.fn(),
}))

vi.mock('./resume-run', () => ({
  resumeRun: vi.fn(),
}))

vi.mock('./queue', () => ({
  enqueueWaitUntilResume: vi.fn(),
}))

import { getRunNodeStatus } from './persistence'
import { enqueueWaitUntilResume } from './queue'
import { resumeRun } from './resume-run'
import { handleWaitResume, resolveWaitUntilDelay } from './wait-until'

const getRunNodeStatusMock = vi.mocked(getRunNodeStatus)
const enqueueWaitUntilResumeMock = vi.mocked(enqueueWaitUntilResume)
const resumeRunMock = vi.mocked(resumeRun)

describe('resolveWaitUntilDelay', () => {
  it('returns ms for a valid ISO 8601 duration', () => {
    expect(resolveWaitUntilDelay({ duration: 'PT1S' })).toBe(1000)
    expect(resolveWaitUntilDelay({ duration: 'P3D' })).toBe(3 * 86_400_000)
  })

  it('rejects empty / missing duration', () => {
    expect(() => resolveWaitUntilDelay({})).toThrow(/duration is required/)
    expect(() => resolveWaitUntilDelay(null)).toThrow(/duration is required/)
    expect(() => resolveWaitUntilDelay({ duration: '' })).toThrow(/duration is required/)
  })

  it('rejects malformed durations with a clear error', () => {
    expect(() => resolveWaitUntilDelay({ duration: 'wat' })).toThrow(/valid ISO 8601 duration/)
    expect(() => resolveWaitUntilDelay({ duration: '3 days' })).toThrow(/valid ISO 8601 duration/)
    expect(() => resolveWaitUntilDelay({ duration: 'PT' })).toThrow(/valid ISO 8601 duration/)
  })

  it('rejects zero / negative durations (use noop instead)', () => {
    expect(() => resolveWaitUntilDelay({ duration: 'PT0S' })).toThrow(/positive number of milliseconds/)
    expect(() => resolveWaitUntilDelay({ duration: 'P0D' })).toThrow(/positive number of milliseconds/)
    expect(() => resolveWaitUntilDelay({ duration: 'P' })).toThrow(/valid ISO 8601 duration/)
  })
})

describe('handleWaitResume — idempotency guard', () => {
  beforeEach(() => {
    getRunNodeStatusMock.mockReset()
    enqueueWaitUntilResumeMock.mockReset()
    resumeRunMock.mockReset()
  })

  it('resumes when the node is still in waiting status', async () => {
    getRunNodeStatusMock.mockResolvedValueOnce('waiting')
    resumeRunMock.mockResolvedValueOnce({ resumed: true })

    await handleWaitResume({ runId: 'r1', nodeId: 'w1' })

    expect(getRunNodeStatusMock).toHaveBeenCalledWith('r1', 'w1')
    expect(resumeRunMock).toHaveBeenCalledWith('r1', 'w1')
  })

  it('retries when the delayed wake-up fires before the node reaches waiting', async () => {
    getRunNodeStatusMock.mockResolvedValueOnce('running')

    await handleWaitResume({ runId: 'r1', nodeId: 'w1' })

    expect(enqueueWaitUntilResumeMock).toHaveBeenCalledWith('r1', 'w1', 1000, 1)
    expect(resumeRunMock).not.toHaveBeenCalled()
  })

  it('caps early wake-up status retries', async () => {
    getRunNodeStatusMock.mockResolvedValueOnce('running')

    await handleWaitResume({ runId: 'r1', nodeId: 'w1', statusCheckAttempts: 60 })

    expect(enqueueWaitUntilResumeMock).not.toHaveBeenCalled()
    expect(resumeRunMock).not.toHaveBeenCalled()
  })

  it('no-ops when the node has already been manually resumed (succeeded)', async () => {
    getRunNodeStatusMock.mockResolvedValueOnce('succeeded')

    await handleWaitResume({ runId: 'r1', nodeId: 'w1' })

    expect(resumeRunMock).not.toHaveBeenCalled()
  })

  it('no-ops when the run was cancelled while the wake-up was pending', async () => {
    getRunNodeStatusMock.mockResolvedValueOnce('cancelled')

    await handleWaitResume({ runId: 'r1', nodeId: 'w1' })

    expect(resumeRunMock).not.toHaveBeenCalled()
  })

  it('no-ops when the node row is gone (status null)', async () => {
    getRunNodeStatusMock.mockResolvedValueOnce(null)

    await handleWaitResume({ runId: 'r1', nodeId: 'w1' })

    expect(resumeRunMock).not.toHaveBeenCalled()
  })

  it('rejects malformed payloads silently (defensive)', async () => {
    await handleWaitResume(null)
    await handleWaitResume({})
    await handleWaitResume({ runId: 'r1' })
    await handleWaitResume({ runId: '', nodeId: 'w1' })

    expect(getRunNodeStatusMock).not.toHaveBeenCalled()
    expect(resumeRunMock).not.toHaveBeenCalled()
  })
})
