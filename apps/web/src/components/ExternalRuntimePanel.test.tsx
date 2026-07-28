import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { useWorkflowStore } from '../store'
import { ExternalRuntimePanel } from './ExternalRuntimePanel'

vi.mock('../api', () => ({ api: vi.fn() }))

const connection = {
  id: 'external-1',
  name: 'Temporal production',
  runtimeKey: 'temporal-prod',
  signingCredentialName: 'temporal-observer',
  enabled: true,
  callbackUrl: '/webhooks/external-runtimes/external-1',
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:00:00.000Z',
}

const recoveryCase = {
  id: 'case-1',
  connectionId: 'external-1',
  subjectKind: 'step',
  externalWorkflowId: 'payment-reconciliation',
  externalRunId: 'run-42',
  externalStepId: 'charge',
  state: 'detected',
  evidenceJson: [{ kind: 'trace', label: 'Open trace', locator: 'trace-42' }],
  firstDetectedAt: '2026-07-27T12:30:00.000Z',
  lastObservedAt: '2026-07-27T12:30:00.000Z',
  observedRecoveredAt: null,
}

beforeEach(() => {
  vi.mocked(api).mockReset()
  useWorkflowStore.setState({ platformVersion: 0 })
})

describe('<ExternalRuntimePanel />', () => {
  it('renders an explicit observer-only boundary and signed shadow case', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/integrations/external-runtimes') {
        return {
          observerOnly: true,
          connections: [connection],
          workflows: [],
          runs: [{
            id: 'run-row-1',
            connectionId: 'external-1',
            externalWorkflowId: 'payment-reconciliation',
            externalRunId: 'run-42',
            status: 'failed',
            lastObservedAt: '2026-07-27T12:30:00.000Z',
          }],
          steps: [],
          cases: [recoveryCase],
        }
      }
      if (path === '/credentials') {
        return [{ id: 'credential-1', name: 'temporal-observer', kind: 'external_runtime_signing_secret' }]
      }
      return null
    })

    render(<ExternalRuntimePanel canWrite />)

    expect(await screen.findByText('Read-only by design')).toBeInTheDocument()
    const row = screen.getByTestId('external-runtime-external-1')
    expect(within(row).getByText('Temporal production')).toBeInTheDocument()
    expect(within(row).getByText(connection.callbackUrl)).toBeInTheDocument()
    const caseRow = screen.getByTestId('external-runtime-case-case-1')
    expect(within(caseRow).getByText('charge')).toBeInTheDocument()
    expect(within(caseRow).getByText('Detected')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /retry|resume|cancel run/i })).toBeNull()
  })

  it('creates an observer only from a dedicated signing credential', async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/integrations/external-runtimes' && init?.method === 'POST') {
        return { connection }
      }
      if (path === '/integrations/external-runtimes') {
        return { observerOnly: true, connections: [], workflows: [], runs: [], steps: [], cases: [] }
      }
      if (path === '/credentials') {
        return [
          { id: 'credential-1', name: 'temporal-observer', kind: 'external_runtime_signing_secret' },
          { id: 'credential-2', name: 'slack-signing', kind: 'slack_signing_secret' },
        ]
      }
      return null
    })

    render(<ExternalRuntimePanel canWrite />)
    fireEvent.click(await screen.findByRole('button', { name: 'New observer' }))
    const form = screen.getByTestId('external-runtime-form')
    fireEvent.change(within(form).getByLabelText('Connection name'), {
      target: { value: 'Temporal production' },
    })
    fireEvent.change(within(form).getByLabelText('Runtime key'), {
      target: { value: 'Temporal-Prod' },
    })
    const credential = within(form).getByLabelText('Signing-secret credential')
    fireEvent.change(credential, { target: { value: 'temporal-observer' } })
    expect(within(credential).queryByText('slack-signing')).toBeNull()
    fireEvent.click(within(form).getByRole('button', { name: 'Create observer' }))

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/integrations/external-runtimes', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Temporal production',
          runtimeKey: 'temporal-prod',
          signingCredentialName: 'temporal-observer',
          enabled: true,
        }),
      })
    })
  })

  it('fails closed on malformed wire rows and hides writes from readers', async () => {
    vi.mocked(api).mockResolvedValue({
      observerOnly: true,
      connections: [{ ...connection, enabled: 'yes' }],
      runs: [{ externalRunId: 42 }],
      cases: [{ ...recoveryCase, state: 'resolved' }],
    })

    render(<ExternalRuntimePanel canWrite={false} />)

    expect(await screen.findByTestId('external-runtime-empty')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New observer' })).toBeNull()
    expect(api).toHaveBeenCalledTimes(1)
  })
})
