import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { __resetBumpCoalesceForTests, useWorkflowStore } from '../store'
import { AiGuidanceSettingsPanel } from './AiGuidanceSettingsPanel'

vi.mock('../api', () => ({ api: vi.fn() }))

const initialState = useWorkflowStore.getState()

describe('<AiGuidanceSettingsPanel />', () => {
  beforeEach(() => {
    __resetBumpCoalesceForTests()
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, platformVersion: 0, toasts: [] }, true)
  })

  it('loads and saves the organization guidance through the config chokepoint', async () => {
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === '/org/config' && init?.method === 'POST') return JSON.parse(String(init.body))
      if (path === '/org/config') return { config: [{ key: 'ai.operatorGuidance', value: 'Prefer approval gates.' }] }
      return null
    })
    render(<AiGuidanceSettingsPanel />)
    const field = await screen.findByTestId('ai-guidance-org-input')
    expect(field).toHaveValue('Prefer approval gates.')
    fireEvent.change(field, { target: { value: 'Prefer bounded retries.' } })
    fireEvent.click(screen.getByTestId('ai-guidance-org-save'))
    await waitFor(() => expect(api).toHaveBeenCalledWith('/org/config', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ key: 'ai.operatorGuidance', value: 'Prefer bounded retries.' }),
    })))
    await waitFor(() => expect(useWorkflowStore.getState().platformVersion).toBe(1))
  })

  it('gates save when UTF-8 content exceeds 8 KiB', async () => {
    vi.mocked(api).mockResolvedValue({ config: [{ key: 'ai.operatorGuidance', value: '' }] })
    render(<AiGuidanceSettingsPanel />)
    const field = await screen.findByTestId('ai-guidance-org-input')
    fireEvent.change(field, { target: { value: 'é'.repeat(4 * 1024 + 1) } })
    expect(screen.getByText(/8 KiB/i)).toBeInTheDocument()
    expect(screen.getByTestId('ai-guidance-org-save')).toBeDisabled()
  })

  it('flags secret-like guidance and blocks the save handler', async () => {
    vi.mocked(api).mockResolvedValue({ config: [{ key: 'ai.operatorGuidance', value: '' }] })
    render(<AiGuidanceSettingsPanel />)
    const field = await screen.findByTestId('ai-guidance-org-input')

    fireEvent.change(field, {
      target: { value: 'Use redis://operator:super-secret@cache.internal/0' },
    })

    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Guidance contains a secret-like value. Remove it before saving.')).toBeInTheDocument()
    expect(screen.getByTestId('ai-guidance-org-save')).toBeDisabled()
    fireEvent.click(screen.getByTestId('ai-guidance-org-save'))
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('preserves an unsaved draft across unrelated platform invalidations', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ config: [{ key: 'ai.operatorGuidance', value: 'Loaded guidance.' }] })
      .mockResolvedValueOnce({ config: [{ key: 'ai.operatorGuidance', value: 'Server changed elsewhere.' }] })
    render(<AiGuidanceSettingsPanel />)
    const field = await screen.findByTestId('ai-guidance-org-input')
    fireEvent.change(field, { target: { value: 'Unsaved operator draft.' } })
    useWorkflowStore.setState({ platformVersion: 1 })
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2))
    expect(field).toHaveValue('Unsaved operator draft.')
  })

  it('blocks save on a malformed initial envelope and recovers through retry', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ config: [] })
      .mockResolvedValueOnce({ config: [{ key: 'ai.operatorGuidance', value: 'Recovered guidance.' }] })
    render(<AiGuidanceSettingsPanel />)
    const field = await screen.findByTestId('ai-guidance-org-input')
    expect(api).toHaveBeenNthCalledWith(1, '/org/config', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }))
    expect(field).toBeDisabled()
    expect(screen.getByTestId('ai-guidance-org-save')).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load AI guidance.")

    fireEvent.click(screen.getByTestId('ai-guidance-org-retry'))
    await waitFor(() => expect(field).toBeEnabled())
    expect(api).toHaveBeenNthCalledWith(2, '/org/config', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }))
    expect(field).toHaveValue('Recovered guidance.')
  })
})
