import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { CredentialRevokeDialog } from './CredentialRevokeDialog'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

const NAME = 'demo-slack'
const SECRET_CANARY = 'secret-canary-value'
const WORKFLOWS = [
  { id: 'wf-1', name: 'Incident triage' },
  { id: 'wf-2', name: 'Support escalation' },
]

function healthWith(referencingWorkflowIds: unknown) {
  return {
    managedStorageAvailable: true,
    mcpConnections: [],
    credentials: [{
      id: 'cred-1',
      name: NAME,
      kind: 'slack',
      secretRefPresent: true,
      lastErrorMessage: `upstream rejected ${SECRET_CANARY}`,
      referencingWorkflowIds,
    }],
  }
}

function renderDialog(onRevoke = vi.fn<(name: string) => Promise<boolean>>(async () => true)) {
  const onClose = vi.fn()
  render(<CredentialRevokeDialog credentialName={NAME} workflows={WORKFLOWS} onClose={onClose} onRevoke={onRevoke} />)
  return { onClose, onRevoke }
}

beforeEach(() => {
  vi.mocked(api).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('<CredentialRevokeDialog />', () => {
  it('lists affected workflows and only revokes after the exact name is typed', async () => {
    vi.mocked(api).mockResolvedValue(healthWith(['wf-1', 'wf-2']))
    const { onClose, onRevoke } = renderDialog()

    const input = await screen.findByTestId('credential-revoke-typed-name')
    expect(api).toHaveBeenCalledWith('/credentials/health', { signal: expect.any(AbortSignal) })
    const rows = within(screen.getByRole('list', { name: 'Affected workflows (2)' })).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual(['Incident triage', 'Support escalation'])
    expect(screen.getByLabelText(`Type ${NAME} to confirm`)).toBe(input)
    expect(input).toHaveFocus()

    const confirm = screen.getByTestId('credential-revoke-confirm')
    for (const attempt of ['', 'demo', 'DEMO-SLACK', 'demo-slack2']) {
      fireEvent.change(input, { target: { value: attempt } })
      expect(confirm).toBeDisabled()
      fireEvent.submit(input.closest('form')!)
    }
    expect(onRevoke).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: NAME } })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onRevoke).toHaveBeenCalledTimes(1)
    expect(onRevoke).toHaveBeenCalledWith(NAME)
  })

  it('asks for a plain confirmation when no workflow references the connection', async () => {
    vi.mocked(api).mockResolvedValue(healthWith([]))
    const { onClose, onRevoke } = renderDialog()

    await screen.findByRole('heading', { name: 'Affected workflows (0)' })
    const confirm = screen.getByTestId('credential-revoke-confirm')
    expect(confirm).toBeEnabled()
    expect(screen.queryByTestId('credential-revoke-typed-name')).not.toBeInTheDocument()
    expect(screen.getByTestId('credential-revoke-cancel')).toHaveFocus()

    fireEvent.click(confirm)
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onRevoke).toHaveBeenCalledWith(NAME)
  })

  it('keeps Revoke disabled while the affected workflows load', () => {
    vi.mocked(api).mockReturnValue(new Promise(() => {}))
    const { onRevoke } = renderDialog()

    expect(screen.getByText('Finding workflows that use this credential…')).toBeInTheDocument()
    const confirm = screen.getByTestId('credential-revoke-confirm')
    expect(confirm).toBeDisabled()
    fireEvent.submit(confirm.closest('form')!)
    expect(onRevoke).not.toHaveBeenCalled()
    expect(screen.getByTestId('credential-revoke-cancel')).toBeEnabled()
  })

  it.each([
    ['a failed read', () => Promise.reject(new Error('health unavailable'))],
    ['an empty response', () => Promise.resolve(null)],
    ['a response without the credential', () => Promise.resolve({ credentials: [] })],
    ['a malformed credentials field', () => Promise.resolve({ credentials: 'nope' })],
    ['a missing reference list', () => Promise.resolve(healthWith(undefined))],
    ['a malformed reference list', () => Promise.resolve(healthWith([1, 2]))],
  ])('fails safe on %s: says so and requires the typed name', async (_label, health) => {
    vi.mocked(api).mockImplementation(health as unknown as typeof api)
    const { onClose, onRevoke } = renderDialog()

    expect(await screen.findByRole('status')).toHaveTextContent('Could not load the affected workflows.')
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    const confirm = screen.getByTestId('credential-revoke-confirm')
    expect(confirm).toBeDisabled()

    fireEvent.change(screen.getByTestId('credential-revoke-typed-name'), { target: { value: NAME } })
    fireEvent.click(confirm)
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onRevoke).toHaveBeenCalledTimes(1)
  })

  it('falls back to the safe path when the health read hangs', async () => {
    const timeout = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    vi.mocked(api).mockImplementation(((_path: string, options?: RequestInit) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Request cancelled', 'AbortError')))
    })) as unknown as typeof api)
    renderDialog()

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(timeoutSpy).toHaveBeenCalledWith(10_000)
    act(() => timeout.abort())
    expect(await screen.findByRole('status')).toHaveTextContent('Could not load the affected workflows.')
    expect(screen.getByTestId('credential-revoke-typed-name')).toBeInTheDocument()
  })

  it('keeps a row and the typed name for a workflow without a loaded name', async () => {
    vi.mocked(api).mockResolvedValue(healthWith(['wf-unlisted']))
    renderDialog()

    expect(await screen.findByRole('listitem')).toHaveTextContent('wf-unlisted')
    expect(screen.getByRole('heading', { name: 'Affected workflows (1)' })).toBeInTheDocument()
    expect(screen.getByTestId('credential-revoke-typed-name')).toBeInTheDocument()
  })

  it('stays open with the typed name after a failed revoke so it can be retried', async () => {
    vi.mocked(api).mockResolvedValue(healthWith(['wf-1']))
    const onRevoke = vi.fn<(name: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const { onClose } = renderDialog(onRevoke)

    const input = await screen.findByTestId('credential-revoke-typed-name')
    fireEvent.change(input, { target: { value: NAME } })
    const confirm = screen.getByTestId('credential-revoke-confirm')
    fireEvent.click(confirm)

    await waitFor(() => expect(onRevoke).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(confirm).toBeEnabled())
    expect(onClose).not.toHaveBeenCalled()
    expect(input).toHaveValue(NAME)
    expect(screen.getByRole('alertdialog')).toHaveFocus()

    fireEvent.click(confirm)
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onRevoke).toHaveBeenCalledTimes(2)
  })

  it('cannot be dismissed or resubmitted while the revoke is in flight', async () => {
    vi.mocked(api).mockResolvedValue(healthWith([]))
    const onRevoke = vi.fn<(name: string) => Promise<boolean>>(() => new Promise(() => {}))
    const { onClose } = renderDialog(onRevoke)

    await screen.findByRole('heading', { name: 'Affected workflows (0)' })
    const confirm = screen.getByTestId('credential-revoke-confirm')
    fireEvent.click(confirm)
    await waitFor(() => expect(confirm).toBeDisabled())

    fireEvent.submit(confirm.closest('form')!)
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('alertdialog').parentElement!)
    expect(screen.getByTestId('credential-revoke-cancel')).toBeDisabled()
    expect(onClose).not.toHaveBeenCalled()
    expect(onRevoke).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape and on a backdrop click when idle', async () => {
    vi.mocked(api).mockResolvedValue(healthWith([]))
    const { onClose } = renderDialog()

    await screen.findByRole('heading', { name: 'Affected workflows (0)' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('alertdialog'))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('alertdialog').parentElement!)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('never renders health error text or a masked secret field', async () => {
    vi.mocked(api).mockResolvedValue(healthWith(['wf-1']))
    renderDialog()

    const input = await screen.findByTestId('credential-revoke-typed-name')
    expect(document.body.textContent).not.toContain(SECRET_CANARY)
    expect(input).toHaveAttribute('autocomplete', 'off')
    expect(input).not.toHaveAttribute('type', 'password')
  })
})
