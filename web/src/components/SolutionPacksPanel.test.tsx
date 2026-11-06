import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { Credential, SolutionPackPublic } from '../types'
import { changeRuntimeLocale } from '../i18n'
import type { CreateCredential } from './CredentialCreateDialog'
import { SolutionPacksPanel } from './SolutionPacksPanel'

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  api: vi.fn(),
}))

const PACK: SolutionPackPublic = {
  id: 'incident-triage',
  name: 'Incident triage',
  description: 'Classify an alert and notify responders.',
  category: 'incident_triage',
  version: '1.2.0',
  assurance: {
    intentContract: true,
    recoveryContractVersion: '2',
    qualificationFixtureCount: 2,
  },
  requiredCredentials: [
    { name: 'ops_slack', kind: 'slack_webhook', purpose: 'Pages your on-call channel' },
  ],
  requiredOrgConfigs: [],
  nodeCount: 4,
  sampleCount: 1,
  failureCount: 2,
  samplePayloadIds: ['default'],
  failureFixtureIds: ['github_secret_unbound', 'worker_interrupted_during_page'],
  failureFixtures: [
    {
      id: 'github_secret_unbound',
      label: 'GitHub credential unavailable',
      description: 'The issue node crosses the real worker boundary before a safe missing-secret probe fails.',
      failureMode: 'credential_unavailable',
      recoveryPath: 'runtime_failure',
    },
    {
      id: 'worker_interrupted_during_page',
      label: 'Worker interrupted during on-call page',
      description: 'A stale running claim crosses the configured threshold.',
      failureMode: 'worker_stalled',
      recoveryPath: 'stalled_node_reaper',
    },
  ],
}

const credentialRow = (name: string) => screen.getByText(name).closest('li')
const checklist = () => screen.getByRole('region', { name: /^(Before installing|Antes de instalar)/ })

const handlers = {
  onInstall: vi.fn(),
  onSampleRun: vi.fn(),
  onInjectFailure: vi.fn(),
}

function renderPanel(credentials: Credential[]) {
  return render(
    <SolutionPacksPanel
      packs={[PACK]}
      credentials={credentials}
      onInstall={handlers.onInstall}
      onSampleRun={handlers.onSampleRun}
      onInjectFailure={handlers.onInjectFailure}
    />,
  )
}

describe('<SolutionPacksPanel />', () => {
  // The cold dialog chunk can outlast a query's timeout on a loaded machine.
  beforeAll(() => import('./connection-dialogs'))

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api).mockResolvedValue({ credentials: [], managedStorageAvailable: true })
    useWorkflowStore.setState({ activeTab: 'packs' })
  })

  it('treats a credential as present only when both kind and name match', () => {
    const { rerender } = renderPanel([
      { id: 'cred-1', name: 'ops_slack', kind: 'github_token' },
    ])

    const row = credentialRow('ops_slack')
    expect(row).toHaveAttribute('data-state', 'wrongKind')
    expect(row).toHaveAccessibleName('ops_slack (slack_webhook): Exists as github_token')

    rerender(
      <SolutionPacksPanel
        packs={[PACK]}
        credentials={[{ id: 'cred-2', name: 'ops_slack', kind: 'slack_webhook' }]}
        onInstall={handlers.onInstall}
        onSampleRun={handlers.onSampleRun}
        onInjectFailure={handlers.onInjectFailure}
      />,
    )

    expect(row).toHaveAttribute('data-state', 'ready')
    expect(row).toHaveAccessibleName('ops_slack (slack_webhook): Connected')
    expect(row).toHaveTextContent('Connected')
  })

  it('counts only credentials and never contradicts itself with a legend', () => {
    render(
      <SolutionPacksPanel
        packs={[{
          ...PACK,
          requiredCredentials: [
            ...PACK.requiredCredentials,
            { name: 'ops_github', kind: 'github_token', purpose: 'Files the incident' },
          ],
          requiredOrgConfigs: [{ key: 'email.from', purpose: 'Reply sender' }],
        }]}
        credentials={[{ id: 'cred-1', name: 'ops_slack', kind: 'slack_webhook' }]}
        onInstall={handlers.onInstall}
        onSampleRun={handlers.onSampleRun}
        onInjectFailure={handlers.onInjectFailure}
        onCreateCredential={vi.fn()}
      />,
    )

    expect(checklist()).toHaveAccessibleName('Before installing · 1 of 2 ready')
    expect(checklist()).not.toHaveTextContent('Not configured')

    const config = screen.getByText('email.from').closest('li')
    expect(config).toHaveTextContent('Organization setting')
    expect(config).toHaveAttribute('title', 'Reply sender')
    expect(config).not.toHaveAttribute('data-state')
    expect(screen.queryByTestId('pack-connect-incident-triage-email.from')).not.toBeInTheDocument()
  })

  it('agrees the count with a single credential in Spanish', async () => {
    await changeRuntimeLocale('es')
    try {
      renderPanel([])
      expect(checklist()).toHaveAccessibleName('Antes de instalar · 0 de 1 lista')
    } finally {
      await act(() => changeRuntimeLocale('en'))
    }
  })

  it('leaves out the count when a pack requires only organization settings', () => {
    render(
      <SolutionPacksPanel
        packs={[{ ...PACK, requiredCredentials: [], requiredOrgConfigs: [{ key: 'email.from', purpose: 'Reply sender' }] }]}
        credentials={[]}
        onInstall={handlers.onInstall}
        onSampleRun={handlers.onSampleRun}
        onInjectFailure={handlers.onInjectFailure}
      />,
    )
    expect(checklist()).toHaveAccessibleName('Before installing')
  })

  it('gives Install its primary weight only once every credential is ready, and never disables it for one', () => {
    const { rerender } = renderPanel([])
    const install = screen.getByTestId('pack-install-incident-triage')
    expect(install).toHaveClass('ui-button--secondary')
    expect(install).toBeEnabled()

    rerender(
      <SolutionPacksPanel
        packs={[PACK]}
        credentials={[{ id: 'cred-1', name: 'ops_slack', kind: 'slack_webhook' }]}
        onInstall={handlers.onInstall}
        onSampleRun={handlers.onSampleRun}
        onInjectFailure={handlers.onInjectFailure}
      />,
    )
    expect(install).toHaveClass('ui-button--primary')
  })

  it('offers Connect only on missing rows and only to a role that can create credentials', () => {
    const { rerender } = renderPanel([])
    expect(screen.queryByTestId('pack-connect-incident-triage-ops_slack')).not.toBeInTheDocument()
    expect(credentialRow('ops_slack')).toHaveTextContent('Credential missing')

    rerender(
      <SolutionPacksPanel
        packs={[PACK]}
        credentials={[]}
        onInstall={handlers.onInstall}
        onSampleRun={handlers.onSampleRun}
        onInjectFailure={handlers.onInjectFailure}
        onCreateCredential={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Connect ops_slack' }))
      .toBe(screen.getByTestId('pack-connect-incident-triage-ops_slack'))

    rerender(
      <SolutionPacksPanel
        packs={[PACK]}
        credentials={[{ id: 'cred-1', name: 'ops_slack', kind: 'slack_webhook' }]}
        onInstall={handlers.onInstall}
        onSampleRun={handlers.onSampleRun}
        onInjectFailure={handlers.onInjectFailure}
        onCreateCredential={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('pack-connect-incident-triage-ops_slack')).not.toBeInTheDocument()
  })

  const FUTURE = new Date(Date.now() + 86_400_000).toISOString()
  const PAST = new Date(Date.now() - 86_400_000).toISOString()

  function renderConnectable(credentials: Credential[], extra: { canInstall?: boolean; credentialsKnown?: boolean } = {}) {
    return render(
      <SolutionPacksPanel
        packs={[PACK]}
        credentials={credentials}
        onInstall={handlers.onInstall}
        onSampleRun={handlers.onSampleRun}
        onInjectFailure={handlers.onInjectFailure}
        onCreateCredential={vi.fn()}
        {...extra}
      />,
    )
  }

  it.each([
    ['a name held by another kind', [{ id: 'c', name: 'ops_slack', kind: 'github_token' }], 'wrongKind', 'Exists as github_token', []],
    ['an expired credential', [{ id: 'c', name: 'ops_slack', kind: 'slack_webhook', expiresAt: PAST }], 'expired', 'Expired', []],
    ['a variable unset on the server', [{ id: 'c', name: 'ops_slack', kind: 'slack_webhook', storage: 'environment' as const }], 'unset', 'Secret not set', ['ops_slack']],
  ])('offers Review instead of Connect on %s, and never counts it as ready', async (_label, credentials, state, text, unset) => {
    vi.mocked(api).mockResolvedValue({
      managedStorageAvailable: true,
      credentials: unset.map((name) => ({ name, secretRefPresent: false })),
    })
    renderConnectable(credentials)

    const row = credentialRow('ops_slack')
    await waitFor(() => expect(row).toHaveAttribute('data-state', state))
    expect(row).toHaveTextContent(text)
    expect(row).toHaveAccessibleName(`ops_slack (slack_webhook): ${text}`)
    expect(checklist()).toHaveAccessibleName('Before installing · 0 of 1 ready')
    expect(screen.getByTestId('pack-install-incident-triage')).toHaveClass('ui-button--secondary')
    expect(screen.getByTestId('pack-note-incident-triage')).toHaveTextContent('Set up ops_slack before running it.')
    expect(screen.queryByTestId('pack-connect-incident-triage-ops_slack')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('pack-review-incident-triage-ops_slack'))
    expect(useWorkflowStore.getState().activeTab).toBe('credentials')
  })

  it('counts a credential with a future expiry as ready', () => {
    renderConnectable([{ id: 'c', name: 'ops_slack', kind: 'slack_webhook', expiresAt: FUTURE }])

    expect(credentialRow('ops_slack')).toHaveAttribute('data-state', 'ready')
    expect(screen.getByTestId('pack-install-incident-triage')).toHaveClass('ui-button--primary')
    expect(screen.queryByTestId('pack-review-incident-triage-ops_slack')).not.toBeInTheDocument()
  })

  it('reads health once for the whole panel, however many rows and dialogs it shows', async () => {
    render(
      <SolutionPacksPanel
        packs={[{
          ...PACK,
          requiredCredentials: [
            ...PACK.requiredCredentials,
            { name: 'ops_github', kind: 'github_token', purpose: 'Files the incident' },
          ],
        }]}
        credentials={[]}
        onInstall={handlers.onInstall}
        onSampleRun={handlers.onSampleRun}
        onInjectFailure={handlers.onInjectFailure}
        onCreateCredential={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('pack-connect-incident-triage-ops_slack'))
    await screen.findByLabelText(/^Secret value/)

    expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/credentials/health')).toHaveLength(1)
  })

  it('keeps a row ready when health cannot be read, since nothing proves the secret is unset', async () => {
    vi.mocked(api).mockRejectedValue(new Error('offline'))
    renderConnectable([{ id: 'c', name: 'ops_slack', kind: 'slack_webhook' }])

    await waitFor(() => expect(api).toHaveBeenCalledWith('/credentials/health'))
    expect(credentialRow('ops_slack')).toHaveAttribute('data-state', 'ready')
  })

  it('forgets which secrets were unset when the list stops being known, as on an organization switch', async () => {
    const panel = (credentialsKnown: boolean) => (
      <SolutionPacksPanel
        packs={[PACK]}
        credentials={[{ id: 'c', name: 'ops_slack', kind: 'slack_webhook' }]}
        credentialsKnown={credentialsKnown}
        onInstall={handlers.onInstall}
        onSampleRun={handlers.onSampleRun}
        onInjectFailure={handlers.onInjectFailure}
      />
    )
    vi.mocked(api).mockResolvedValue({ credentials: [{ name: 'ops_slack', secretRefPresent: false }] })
    const { rerender } = render(panel(true))
    await waitFor(() => expect(credentialRow('ops_slack')).toHaveAttribute('data-state', 'unset'))

    vi.mocked(api).mockRejectedValue(new Error('offline'))
    rerender(panel(false))
    rerender(panel(true))
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2))
    expect(credentialRow('ops_slack')).toHaveAttribute('data-state', 'ready')
  })

  it('claims nothing about a credential list it could not read', () => {
    renderConnectable([], { credentialsKnown: false })

    const row = credentialRow('ops_slack')
    expect(row).toHaveAttribute('data-state', 'unknown')
    expect(row).toHaveTextContent('Status unavailable')
    expect(row).toHaveAccessibleName('ops_slack (slack_webhook): Status unavailable')
    expect(row).not.toHaveTextContent('missing')
    expect(checklist()).toHaveAccessibleName('Before installing')
    expect(screen.queryByTestId('pack-connect-incident-triage-ops_slack')).not.toBeInTheDocument()
    expect(screen.queryByTestId('pack-review-incident-triage-ops_slack')).not.toBeInTheDocument()
    expect(screen.queryByTestId('pack-note-incident-triage')).not.toBeInTheDocument()
    expect(screen.getByTestId('pack-install-incident-triage')).toHaveClass('ui-button--secondary')
    expect(api).not.toHaveBeenCalled()
  })

  function ConnectHarness({ pack = PACK, onCreate, createCredential, canInstall }: {
    pack?: SolutionPackPublic
    onCreate?: (credential: { name: string; kind: string; secretValue?: string }) => void
    /** Replaces the always-successful create: gets the list setter, as the app's refresh would. */
    createCredential?: (setCredentials: (list: Credential[]) => void) => ReturnType<CreateCredential>
    canInstall?: boolean
  }) {
    const [credentials, setCredentials] = useState<Credential[]>([])
    return (
      <SolutionPacksPanel
        packs={[pack]}
        credentials={credentials}
        canInstall={canInstall}
        onInstall={handlers.onInstall}
        onSampleRun={handlers.onSampleRun}
        onInjectFailure={handlers.onInjectFailure}
        onCreateCredential={async (credential) => {
          if (createCredential) return createCredential(setCredentials)
          onCreate?.(credential)
          setCredentials((current) => [...current, { id: credential.name, name: credential.name, kind: credential.kind }])
          return true
        }}
      />
    )
  }

  it('connects a credential in place with its name and kind locked, then marks the row ready', async () => {
    const onCreate = vi.fn()
    render(<ConnectHarness onCreate={onCreate} />)

    fireEvent.click(screen.getByTestId('pack-connect-incident-triage-ops_slack'))
    const name = await screen.findByLabelText(/^Connection name/)
    expect(api).toHaveBeenCalledWith('/credentials/health')
    expect(name).toHaveValue('ops_slack')
    expect(name).toBeDisabled()
    const kind = screen.getByLabelText(/^Connection kind/)
    expect(kind).toHaveValue('slack_webhook')
    expect(kind).toBeDisabled()
    const secret = screen.getByLabelText(/^Secret value/)
    await waitFor(() => expect(secret).toHaveFocus())

    fireEvent.change(secret, { target: { value: 'hunter2' } })
    fireEvent.submit(secret.closest('form')!)

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onCreate).toHaveBeenCalledWith({ name: 'ops_slack', kind: 'slack_webhook', secretValue: 'hunter2' })
    expect(credentialRow('ops_slack')).toHaveAttribute('data-state', 'ready')
    expect(checklist()).toHaveAccessibleName('Before installing · 1 of 1 ready')
    expect(screen.getByTestId('pack-install-incident-triage')).toHaveClass('ui-button--primary')
    expect(screen.queryByTestId('pack-note-incident-triage')).not.toBeInTheDocument()
  })

  it.each([
    ['the next Connect while one is still missing', [
      ...PACK.requiredCredentials,
      { name: 'ops_github', kind: 'github_token', purpose: 'Files the incident' },
    ], 'pack-connect-incident-triage-ops_github'],
    ['Install once none is', PACK.requiredCredentials, 'pack-install-incident-triage'],
  ])('moves focus to %s, since the connected row lost its opener', async (_label, requiredCredentials, target) => {
    render(<ConnectHarness pack={{ ...PACK, requiredCredentials }} onCreate={vi.fn()} />)

    fireEvent.click(screen.getByTestId('pack-connect-incident-triage-ops_slack'))
    const secret = await screen.findByLabelText(/^Secret value/)
    fireEvent.change(secret, { target: { value: 'hunter2' } })
    fireEvent.submit(secret.closest('form')!)

    await waitFor(() => expect(screen.getByTestId(target)).toHaveFocus())
  })

  async function submitConnect() {
    fireEvent.click(screen.getByTestId('pack-connect-incident-triage-ops_slack'))
    const secret = await screen.findByLabelText(/^Secret value/)
    fireEvent.change(secret, { target: { value: 'hunter2' } })
    fireEvent.submit(secret.closest('form')!)
    return secret
  }

  it.each([
    ['the same kind', 'slack_webhook', 'ready'],
    ['another kind', 'github_token', 'wrongKind'],
  ])('closes on a conflict once the refreshed list shows the name, held by %s', async (_label, kind, state) => {
    render(<ConnectHarness createCredential={async (setCredentials) => {
      setCredentials([{ id: 'other-admin', name: 'ops_slack', kind }])
      return false
    }} />)
    await submitConnect()

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(credentialRow('ops_slack')).toHaveAttribute('data-state', state)
    expect(screen.queryByTestId('pack-connect-incident-triage-ops_slack')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('pack-install-incident-triage')).toHaveFocus())
  })

  it('stays open with the typed secret when a failed create changes nothing in the list', async () => {
    const create = vi.fn(async () => false)
    render(<ConnectHarness createCredential={create} />)
    const secret = await submitConnect()

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled())
    expect(secret).toHaveValue('hunter2')
    expect(credentialRow('ops_slack')).toHaveAttribute('data-state', 'missing')
  })

  it('moves focus as soon as the list holds the name, without waiting for the refresh behind the create', async () => {
    let finish = (_created: boolean) => {}
    render(<ConnectHarness createCredential={(setCredentials) => {
      setCredentials([{ id: 'new', name: 'ops_slack', kind: 'slack_webhook' }])
      return new Promise((resolve) => { finish = resolve })
    }} />)
    await submitConnect()

    await waitFor(() => expect(screen.getByTestId('pack-install-incident-triage')).toHaveFocus())
    await act(async () => { finish(true) })
    expect(screen.getByTestId('pack-install-incident-triage')).toHaveFocus()
  })

  it('moves focus to the checklist when the role connects but cannot install', async () => {
    render(<ConnectHarness canInstall={false} onCreate={vi.fn()} />)
    await submitConnect()

    await waitFor(() => expect(checklist()).toHaveFocus())
    expect(screen.getByTestId('pack-install-incident-triage')).toBeDisabled()
  })

  it('returns focus to the opener when the dialog is cancelled', async () => {
    render(<ConnectHarness onCreate={vi.fn()} />)
    const connect = screen.getByTestId('pack-connect-incident-triage-ops_slack')
    connect.focus()
    fireEvent.click(connect)
    await screen.findByLabelText(/^Secret value/)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(connect).toHaveFocus())
  })

  it('offers only environment storage when the health check says managed storage is unavailable', async () => {
    vi.mocked(api).mockRejectedValue(new Error('offline'))
    render(<ConnectHarness onCreate={vi.fn()} />)

    fireEvent.click(screen.getByTestId('pack-connect-incident-triage-ops_slack'))
    const storage = await screen.findByLabelText(/^Secret storage/)
    await waitFor(() => expect(storage).toHaveValue('environment'))
  })

  it('shows the executable assurance included with a qualified pack', () => {
    renderPanel([])

    const assurance = screen.getByTestId('pack-assurance-incident-triage')
    expect(assurance).toHaveAccessibleName('Executable assurance included')
    expect(assurance).toHaveTextContent('Intent contract')
    expect(assurance).toHaveTextContent('Recovery V2')
    expect(assurance).toHaveTextContent('2 qualification fixtures')
  })

  it('names only the unconnected credentials and keeps Install available', () => {
    const pack: SolutionPackPublic = {
      ...PACK,
      requiredCredentials: [
        ...PACK.requiredCredentials,
        { name: 'ops_github', kind: 'github_token', purpose: 'Files the incident' },
        { name: 'ops_pager', kind: 'pagerduty_api_token', purpose: 'Pages on call' },
      ],
    }
    const panel = (credentials: Credential[]) => (
      <SolutionPacksPanel
        packs={[pack]}
        credentials={credentials}
        onInstall={handlers.onInstall}
        onSampleRun={handlers.onSampleRun}
        onInjectFailure={handlers.onInjectFailure}
      />
    )
    const { rerender } = render(panel([{ id: 'cred-1', name: 'ops_slack', kind: 'slack_webhook' }]))

    const note = screen.getByTestId('pack-note-incident-triage')
    expect(note).toHaveTextContent('Set up ops_github and ops_pager before running it.')
    const install = screen.getByRole('button', { name: 'Install' })
    expect(install).toHaveAccessibleDescription(note.textContent)
    fireEvent.click(install)
    expect(handlers.onInstall).toHaveBeenCalledWith('incident-triage')

    rerender(panel([
      { id: 'cred-1', name: 'ops_slack', kind: 'slack_webhook' },
      { id: 'cred-2', name: 'ops_github', kind: 'github_token' },
      { id: 'cred-3', name: 'ops_pager', kind: 'pagerduty_api_token' },
    ]))
    expect(screen.queryByTestId('pack-note-incident-triage')).not.toBeInTheDocument()
    expect(install).not.toHaveAttribute('aria-describedby')
  })

  it('joins the credential names for the active language', async () => {
    await changeRuntimeLocale('es')
    try {
      render(
        <SolutionPacksPanel
          packs={[{
            ...PACK,
            requiredCredentials: [
              ...PACK.requiredCredentials,
              { name: 'ops_github', kind: 'github_token', purpose: 'Files the incident' },
            ],
          }]}
          credentials={[]}
          onInstall={handlers.onInstall}
          onSampleRun={handlers.onSampleRun}
          onInjectFailure={handlers.onInjectFailure}
        />,
      )
      expect(screen.getByTestId('pack-note-incident-triage'))
        .toHaveTextContent('Configura ops_slack y ops_github antes de ejecutarlo.')
    } finally {
      await act(() => changeRuntimeLocale('en'))
    }
  })

  it('explains a disabled Install by role, not by credentials', () => {
    render(
      <SolutionPacksPanel
        packs={[PACK]}
        credentials={[]}
        canInstall={false}
        onInstall={handlers.onInstall}
        onSampleRun={handlers.onSampleRun}
        onInjectFailure={handlers.onInjectFailure}
      />,
    )

    expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled()
    expect(screen.getByTestId('pack-note-incident-triage'))
      .toHaveTextContent("Your role can't install or run packs.")
  })

  it('filters out non-matching packs and offers clear-filter', () => {
    renderPanel([{ id: 'cred-2', name: 'ops_slack', kind: 'slack_webhook' }])
    expect(screen.getByText('ops_slack')).toBeInTheDocument()

    const input = screen.getByPlaceholderText('Search packs…')
    fireEvent.change(input, { target: { value: 'zzz-no-match' } })
    expect(screen.getByText('No packs match')).toBeInTheDocument()
    expect(screen.queryByText('ops_slack')).not.toBeInTheDocument()
    expect(screen.getByTestId('empty-state-cta')).toHaveTextContent('Clear filter')
  })

  it('reprojects a pack search when the active language changes', async () => {
    await changeRuntimeLocale('en')
    renderPanel([])
    const input = screen.getByPlaceholderText('Search packs…')
    fireEvent.change(input, { target: { value: 'classify' } })
    expect(screen.getByTestId('solution-pack-incident-triage')).toBeInTheDocument()

    try {
      await act(() => changeRuntimeLocale('es'))
      expect(input).toHaveValue('classify')
      expect(screen.getByText('Ningún pack coincide')).toBeInTheDocument()

      fireEvent.change(input, { target: { value: 'clasifica' } })
      expect(screen.getByTestId('solution-pack-incident-triage')).toBeInTheDocument()
    } finally {
      await act(() => changeRuntimeLocale('en'))
    }
  })

  it('shows an explore-templates CTA when the catalog is empty', () => {
    render(
      <SolutionPacksPanel
        packs={[]}
        credentials={[]}
        onInstall={handlers.onInstall}
        onSampleRun={handlers.onSampleRun}
        onInjectFailure={handlers.onInjectFailure}
      />,
    )
    expect(screen.getByTestId('empty-state-cta')).toHaveTextContent('Explore templates')
  })

  it('explains the selected drill and sends its explicit fixture id', () => {
    renderPanel([])

    expect(screen.getByTestId('solution-pack-incident-triage')).toBeVisible()
    const select = screen.getByLabelText('Failure scenario')
    expect(select).toHaveValue('github_secret_unbound')
    expect(screen.getByText('Credential unavailable')).toBeVisible()
    expect(screen.getByText('Real runtime path')).toBeVisible()
    expect(screen.getByText(/terminal and non-retryable before sending any request/)).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Start recovery drill' }))
    expect(handlers.onInjectFailure).toHaveBeenCalledWith('incident-triage', 'github_secret_unbound')
  })

  it('identifies the real stalled-node reaper path before starting it', () => {
    renderPanel([])

    fireEvent.change(screen.getByLabelText('Failure scenario'), {
      target: { value: 'worker_interrupted_during_page' },
    })

    expect(screen.getByText('Worker interrupted')).toBeVisible()
    expect(screen.getByText('Real reaper path')).toBeVisible()
    expect(screen.getByText(/controlled stale running claim/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Start recovery drill' }))
    expect(handlers.onInjectFailure).toHaveBeenCalledWith(
      'incident-triage',
      'worker_interrupted_during_page',
    )
  })
})
