import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { initI18n } from '../i18n'
import { ScheduleCronPreview } from './ScheduleCronPreview'

vi.mock('../api', () => {
  const module = ({ api: vi.fn() })
  return {
    ...module,
    // Typed reads route through contractApi; delegate to the same mock so the
    // path-keyed expectations below keep working.
    contractApi: (_operation: string, path: string, _request: unknown, options?: RequestInit) =>
      options === undefined ? module.api(path) : module.api(path, options),
  }
})

beforeEach(() => {
  initI18n('en')
  vi.useFakeTimers()
  vi.mocked(api).mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('<ScheduleCronPreview />', () => {
  it('debounces a valid expression and renders exactly three localized fires', async () => {
    vi.mocked(api).mockResolvedValue({
      valid: true,
      nextFires: [
        '2026-07-15T09:00:00.000Z',
        '2026-07-16T09:00:00.000Z',
        '2026-07-17T09:00:00.000Z',
      ],
    })
    render(<ScheduleCronPreview id="preview" expression="0 9 * * *" enabled />)

    expect(screen.getByText('Calculating the next runs…')).toBeInTheDocument()
    expect(api).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })

    expect(api).toHaveBeenCalledWith('/workflows/schedule-preview?cron=0%209%20*%20*%20*', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(screen.getByText('Next 3 runs')).toBeInTheDocument()
    expect(document.querySelectorAll('#preview li')).toHaveLength(3)
  })

  it('labels invalid and paused states without requesting while paused', async () => {
    vi.mocked(api).mockResolvedValue({ valid: false, nextFires: [] })
    const view = render(<ScheduleCronPreview id="preview" expression="invalid" enabled />)
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(screen.getByText('Use a valid 5-field cron expression.')).toBeInTheDocument()

    vi.mocked(api).mockClear()
    view.rerender(<ScheduleCronPreview id="preview" expression="0 9 * * *" enabled={false} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(screen.getByText('This schedule is paused; no runs will be queued.')).toBeInTheDocument()
    expect(api).not.toHaveBeenCalled()
  })

  it('renders a retryable error when the preview request fails', async () => {
    vi.mocked(api).mockRejectedValue(new Error('offline'))
    render(<ScheduleCronPreview id="preview" expression="0 9 * * *" enabled />)
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(screen.getByText("The next runs couldn't be calculated right now.")).toBeInTheDocument()
  })

  it('ignores a stale preview even when the request implementation does not honor abort', async () => {
    let resolveFirst!: (value: unknown) => void
    const first = new Promise<unknown>((resolve) => { resolveFirst = resolve })
    vi.mocked(api)
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({
        valid: true,
        nextFires: [
          '2026-07-18T09:00:00.000Z',
          '2026-07-19T09:00:00.000Z',
          '2026-07-20T09:00:00.000Z',
        ],
      })
    const view = render(<ScheduleCronPreview id="preview" expression="0 8 * * *" enabled />)
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })

    view.rerender(<ScheduleCronPreview id="preview" expression="0 9 * * *" enabled />)
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(screen.getByText('Next 3 runs')).toBeInTheDocument()

    await act(async () => { resolveFirst({ valid: false, nextFires: [] }); await first })
    expect(screen.getByText('Next 3 runs')).toBeInTheDocument()
    expect(screen.queryByText('Use a valid 5-field cron expression.')).toBeNull()
  })

  it('hides a prior result synchronously when the expression or enabled state changes', async () => {
    vi.mocked(api).mockResolvedValue({
      valid: true,
      nextFires: [
        '2026-07-18T09:00:00.000Z',
        '2026-07-19T09:00:00.000Z',
        '2026-07-20T09:00:00.000Z',
      ],
    })
    const view = render(<ScheduleCronPreview id="preview" expression="0 8 * * *" enabled />)
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(screen.getByText('Next 3 runs')).toBeInTheDocument()

    view.rerender(<ScheduleCronPreview id="preview" expression="0 9 * * *" enabled />)
    expect(screen.queryByText('Next 3 runs')).toBeNull()
    expect(screen.getByText('Calculating the next runs…')).toBeInTheDocument()
    expect(document.getElementById('preview')).toHaveAttribute('data-state', 'loading')

    view.rerender(<ScheduleCronPreview id="preview" expression="0 9 * * *" enabled={false} />)
    expect(screen.queryByText('Next 3 runs')).toBeNull()
    expect(screen.getByText('This schedule is paused; no runs will be queued.')).toBeInTheDocument()
    expect(document.getElementById('preview')).toHaveAttribute('data-state', 'idle')
  })

  it.each([
    [
      'ready',
      {
        valid: true,
        nextFires: [
          '2026-07-18T09:00:00.000Z',
          '2026-07-19T09:00:00.000Z',
          '2026-07-20T09:00:00.000Z',
        ],
      },
      'Next 3 runs',
    ],
    ['invalid', { valid: false, nextFires: [] }, 'Use a valid 5-field cron expression.'],
  ])('does not reuse a %s result after re-enabling the same expression', async (_kind, payload, oldContent) => {
    vi.mocked(api).mockResolvedValueOnce(payload)
    const view = render(<ScheduleCronPreview id="preview" expression="0 8 * * *" enabled />)
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(screen.getByText(oldContent)).toBeInTheDocument()

    view.rerender(<ScheduleCronPreview id="preview" expression="0 8 * * *" enabled={false} />)
    expect(screen.getByText('This schedule is paused; no runs will be queued.')).toBeInTheDocument()

    vi.mocked(api).mockReturnValueOnce(new Promise(() => {}))
    view.rerender(<ScheduleCronPreview id="preview" expression="0 8 * * *" enabled />)
    expect(screen.queryByText(oldContent)).toBeNull()
    expect(screen.getByText('Calculating the next runs…')).toBeInTheDocument()
    expect(document.getElementById('preview')).toHaveAttribute('data-state', 'loading')
  })
})
