import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api, ApiError } from '../api'
import type { SessionContext } from '../identity-context'
import { useWorkflowStore } from '../store'
import { PublishRequestsPanel } from './PublishRequestsPanel'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  const { contractApiOver } = await import('../test/contract-api-mock')
  const api = vi.fn()
  return { ...actual, api, contractApi: contractApiOver(api) }
})

type Refusal = null | 'settled' | 'permission' | 'requester' | 'second_person' | 'creator_unknown' | 'policy_unavailable' | 'stale' | 'stale_base'

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pub-1', workflowId: 'wf-refunds', workflowName: 'Refunds', draftId: 'draft-1', qualificationId: 'qual-1',
    reasons: ['writes', 'steps_removed'], requestedBy: 'agent:c-1', requesterName: 'Claude Code', onBehalfOf: 'me',
    draftedBy: 'agent:c-1', drafterName: 'Claude Code',
    status: 'pending', createdAt: '2026-11-07T10:00:00Z', expiresAt: '2026-11-08T10:00:00Z',
    decidedBy: null, decidedAt: null, decisionReason: null, publishedVersionId: null,
    viewer: { canDecide: true, refusal: null as Refusal },
    ...overrides,
  }
}

const doc = (nodes: unknown[]) => ({ id: 'wf-refunds', name: 'Refunds', dslVersion: '1.0', nodes, edges: [] })

function detail(row = request()) {
  return {
    request: row,
    proposed: doc([{ id: 'post', type: 'http', config: { url: 'https://api.example.com' } }]),
    current: { versionId: 'v3', version: 3, document: doc([{ id: 'post', type: 'http', config: {} }, { id: 'audit', type: 'noop', config: {} }]) },
    effects: [{ nodeId: 'post', type: 'http', tool: '', target: 'api.example.com', writes: true, credentials: ['refunds_token'] }],
    changes: { triggersChanged: [], stepsRemoved: ['audit'], outputsRemoved: [] },
    qualification: {
      status: 'passed',
      checks: [{ code: 'static', status: 'passed', message: 'structure, readiness, contracts, credentials and literals passed' }],
      fixtureRuns: [{ fixture: 'happy path', runId: 'run-9', status: 'passed' }],
    },
  }
}

function signIn() {
  const context: SessionContext = {
    identity: { userId: 'me', email: 'me@example.com', mode: 'janusly-session', source: 'sso' },
    profile: { name: null, email: 'me@example.com' },
    organizations: [{ id: 'org', name: 'Org', plan: null, role: 'editor', roleBase: 'editor', permissions: ['workflows.read', 'workflows.write'],
      usable: true, developmentFallback: false, isOwner: false }],
    invitations: [], currentOrganizationId: 'org', selectionRequired: false, needsOrganization: false,
    truncated: false, invitationsTruncated: false,
  }
  useWorkflowStore.setState({ identityContext: context })
}

type Route = (path: string, init?: RequestInit) => unknown
function routeApi(routes: Record<string, Route>) {
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${path.split('?')[0]}`
    const handler = routes[key]
    if (!handler) throw new Error(`unexpected ${key}`)
    return handler(path, init)
  })
}

function renderPanel() {
  const callbacks = { onOpenWorkflow: vi.fn(), onOpenWorkflowVersion: vi.fn(async () => true), onOpenRun: vi.fn() }
  render(<PublishRequestsPanel canReadMembers={false} {...callbacks} />)
  return callbacks
}

async function openRequest(id = 'pub-1') {
  fireEvent.click(await screen.findByTestId(`publish-request-${id}`))
  return screen.findByTestId('publish-request-detail')
}

describe('<PublishRequestsPanel />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    window.history.replaceState(null, '', '/#/publishRequests')
    signIn()
  })
  afterEach(() => {
    useWorkflowStore.setState({ identityContext: null })
    vi.useRealTimers()
  })

  it('shows the request in decision order: effects, reasons, changes, evidence', async () => {
    routeApi({
      'GET /v1/publish-requests': () => ({ requests: [request()] }),
      'GET /v1/publish-requests/pub-1': () => detail(),
    })
    const { onOpenWorkflow, onOpenRun } = renderPanel()

    expect(await screen.findByTestId('publish-requests-waiting')).toHaveAccessibleName('1 waiting for you')
    const row = screen.getByTestId('publish-request-pub-1')
    expect(row).toHaveTextContent('Claude Code · For: You')
    expect(row).toHaveTextContent('Writes to other systems · Removes steps')
    const article = await openRequest()
    expect(window.location.hash).toBe('#/publishRequests/pub-1')
    const headings = within(article).getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent)
    expect(headings.slice(0, 4)).toEqual(['What it does outside Janusly', 'Why it waits for a person', 'Changes from production', expect.stringContaining('Qualification')])
    expect(within(article).getByTestId('publish-request-effects')).toHaveTextContent(/post.*Writes.*to api\.example\.com.*with refunds_token/)
    expect(within(article).getByTestId('publish-request-removed')).toHaveTextContent('Steps removed: audit')
    expect(await within(article).findByText('v3 in production')).toBeInTheDocument()
    expect(within(article).getByText('Fixture “happy path”')).toBeInTheDocument()

    fireEvent.click(within(article).getByRole('button', { name: 'Open the run for fixture happy path' }))
    expect(onOpenRun).toHaveBeenCalledWith('run-9')
    fireEvent.click(within(article).getByTestId('publish-request-open-workflow'))
    expect(onOpenWorkflow).toHaveBeenCalledWith('wf-refunds')
  })

  it('picks up a request an agent opens while the list is on screen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let requests: unknown[] = []
    routeApi({ 'GET /v1/publish-requests': () => ({ requests }) })
    renderPanel()
    expect(await screen.findByTestId('publish-requests-empty')).toHaveTextContent('No pending requests')

    requests = [request()]
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(await screen.findByTestId('publish-request-pub-1')).toBeInTheDocument()
    expect(screen.queryByTestId('publish-requests-empty')).not.toBeInTheDocument()
  })

  it.each([
    ['second_person', "Your organization asks someone other than the agent's creator to approve. Another member who can edit workflows decides.", false],
    ['requester', 'You requested this publication, so someone else decides it.', false],
    ['permission', 'Deciding needs permission to edit workflows.', false],
    ['stale', 'The qualification expired. The agent must qualify again.', false],
    ['stale_base', 'The workflow changed since the agent drafted this. Reject it so the agent drafts again.', true],
    ['creator_unknown', "The agent that drafted this no longer exists, so a second person can't be confirmed. Reject it.", true],
  ] as const)('offers only what the server allows when refused as %s', async (refusal, message, canReject) => {
    const row = request({ viewer: { canDecide: false, refusal } })
    routeApi({
      'GET /v1/publish-requests': () => ({ requests: [row] }),
      'GET /v1/publish-requests/pub-1': () => detail(row),
    })
    renderPanel()
    const article = await openRequest()
    expect(within(article).getByTestId('publish-request-refusal')).toHaveTextContent(message)
    expect(within(article).queryByTestId('publish-request-approve')).not.toBeInTheDocument()
    expect(Boolean(within(article).queryByTestId('publish-request-reject'))).toBe(canReject)
    expect(screen.queryByText('Needs you')).not.toBeInTheDocument()
  })

  it('approves with an optional reason and links the published version', async () => {
    const bodies: unknown[] = []
    routeApi({
      'GET /v1/publish-requests': () => ({ requests: [request()] }),
      'GET /v1/publish-requests/pub-1': () => detail(),
      'POST /v1/publish-requests/pub-1/approve': (_path, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return { request: request({ status: 'published', decidedBy: 'me', decidedAt: '2026-11-07T11:00:00Z', decisionReason: 'Looks right',
          publishedVersionId: 'v4', viewer: { canDecide: false, refusal: 'settled' } }) }
      },
    })
    const { onOpenWorkflowVersion } = renderPanel()
    const article = await openRequest()
    fireEvent.change(within(article).getByLabelText('Reason'), { target: { value: '  Looks right  ' } })
    fireEvent.click(within(article).getByTestId('publish-request-approve'))

    await waitFor(() => expect(within(article).getByTestId('publish-request-status')).toHaveTextContent('Published'))
    expect(bodies).toEqual([{ reason: 'Looks right' }])
    expect(within(article).queryByTestId('publish-request-approve')).not.toBeInTheDocument()
    expect(within(article).getByTestId('publish-request-decided')).toHaveTextContent('“Looks right”')
    fireEvent.click(within(article).getByTestId('publish-request-open-version'))
    expect(onOpenWorkflowVersion).toHaveBeenCalledWith('wf-refunds', 'v4')
  })

  it('asks for a reason before rejecting and shows it once decided', async () => {
    const bodies: unknown[] = []
    routeApi({
      'GET /v1/publish-requests': () => ({ requests: [request()] }),
      'GET /v1/publish-requests/pub-1': () => detail(),
      'POST /v1/publish-requests/pub-1/reject': (_path, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return { request: request({ status: 'rejected', decidedBy: 'me', decidedAt: '2026-11-07T11:00:00Z',
          decisionReason: 'Needs a retry limit', viewer: { canDecide: false, refusal: 'settled' } }) }
      },
    })
    renderPanel()
    const article = await openRequest()
    fireEvent.click(within(article).getByTestId('publish-request-reject'))
    expect(within(article).getByRole('alert')).toHaveTextContent('Say why you reject it so the agent can fix it.')
    expect(within(article).getByLabelText('Reason')).toHaveFocus()
    expect(bodies).toEqual([])

    fireEvent.change(within(article).getByLabelText('Reason'), { target: { value: 'Needs a retry limit' } })
    fireEvent.click(within(article).getByTestId('publish-request-reject'))
    await waitFor(() => expect(bodies).toEqual([{ reason: 'Needs a retry limit' }]))
    expect(await within(article).findByTestId('publish-request-decided')).toHaveTextContent('“Needs a retry limit”')
  })

  it('shows a stale qualification the server reports and stops offering approval', async () => {
    let reads = 0
    routeApi({
      'GET /v1/publish-requests': () => ({ requests: [request()] }),
      'GET /v1/publish-requests/pub-1': () => {
        reads += 1
        return reads === 1 ? detail() : detail(request({ viewer: { canDecide: false, refusal: 'stale' } }))
      },
      'POST /v1/publish-requests/pub-1/approve': () => {
        throw new ApiError('stale', { code: 'publish_request_stale', statusCode: 409 })
      },
    })
    renderPanel()
    const article = await openRequest()
    fireEvent.click(within(article).getByTestId('publish-request-approve'))

    expect(await screen.findByTestId('publish-request-error')).toHaveTextContent('The qualification expired; the agent must qualify the draft again')
    await waitFor(() => expect(screen.getByTestId('publish-request-refusal')).toHaveTextContent('The qualification expired. The agent must qualify again.'))
    expect(screen.queryByTestId('publish-request-approve')).not.toBeInTheDocument()
  })

  it('filters by state, and Waiting for you keeps only what the viewer may decide', async () => {
    const paths: string[] = []
    const settled = request({ id: 'pub-old', status: 'superseded', viewer: { canDecide: false, refusal: 'settled' } })
    routeApi({
      'GET /v1/publish-requests': (path) => {
        paths.push(path)
        if (path.includes('status=superseded')) return { requests: [settled] }
        return { requests: [request(), request({ id: 'pub-mine', viewer: { canDecide: false, refusal: 'requester' } })] }
      },
      'GET /v1/publish-requests/pub-old': () => detail(settled),
    })
    renderPanel()
    expect(await screen.findByTestId('publish-request-pub-mine')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('publish-requests-filter-yours'))
    await waitFor(() => expect(screen.queryByTestId('publish-request-pub-mine')).not.toBeInTheDocument())
    expect(screen.getByTestId('publish-request-pub-1')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('publish-requests-filter-superseded'))
    const article = await openRequest('pub-old')
    expect(paths.some((path) => path.endsWith('status=superseded'))).toBe(true)
    expect(article).toHaveTextContent('A newer request for this workflow replaced it.')
    expect(within(article).queryByTestId('publish-request-reject')).not.toBeInTheDocument()
  })
})
