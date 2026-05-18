import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { McpConnectionsPanel } from './McpConnectionsPanel'

vi.mock('../api', () => ({ api: vi.fn() }))

const initialState = useWorkflowStore.getState()

const EMPTY = { connections: [] }
const ONE_CONNECTION = {
  connections: [
    {
      id: 'conn-1',
      orgId: 'default',
      alias: 'stripe-prod',
      transport: 'stdio',
      command: 'node',
      args: ['./srv.js'],
      url: null,
      envRefs: { STRIPE_API_KEY: { kind: 'env', name: 'STRIPE_LIVE_KEY' } },
      enabled: true,
      status: 'active',
      statusReason: null,
      toolCount: 2,
      enabledToolCount: 1,
    },
  ],
}
const TOOLS_FOR_CONN_1 = {
  tools: [
    { id: 't1', connectionId: 'conn-1', name: 'list_charges', description: 'List charges', inputSchema: null, writeSide: false, enabled: true, exposeToAi: false },
    { id: 't2', connectionId: 'conn-1', name: 'create_charge', description: 'Create a charge', inputSchema: null, writeSide: true, enabled: false, exposeToAi: false },
  ],
}

beforeEach(() => {
  vi.mocked(api).mockReset()
  useWorkflowStore.setState({ ...initialState, platformVersion: 0, toasts: [] }, true)
})

describe('<McpConnectionsPanel />', () => {
  it('renders the empty state when no connections exist', async () => {
    vi.mocked(api).mockResolvedValueOnce(EMPTY)
    render(<McpConnectionsPanel />)
    await waitFor(() => {
      expect(screen.getByText(/No MCP connections yet/i)).toBeInTheDocument()
    })
  })

  it('renders an existing connection with its status badge and tool counts', async () => {
    vi.mocked(api).mockResolvedValueOnce(ONE_CONNECTION)
    render(<McpConnectionsPanel />)
    await waitFor(() => {
      expect(screen.getByText('stripe-prod')).toBeInTheDocument()
      expect(screen.getByText('active')).toBeInTheDocument()
      expect(screen.getByText(/2 tools \/ 1 enabled/i)).toBeInTheDocument()
    })
  })

  it('loads + renders tools after expanding the accordion', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(ONE_CONNECTION)
      .mockResolvedValueOnce(TOOLS_FOR_CONN_1)
    render(<McpConnectionsPanel />)
    await waitFor(() => expect(screen.getByText('stripe-prod')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Show tools/i }))
    await waitFor(() => {
      expect(screen.getByText('list_charges')).toBeInTheDocument()
      expect(screen.getByText('create_charge')).toBeInTheDocument()
    })
  })

  it('sends exposeToAi when the per-tool AI exposure toggle changes', async () => {
    let toolsFetches = 0
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/mcp/connections') return ONE_CONNECTION
      if (path === '/mcp/connections/stripe-prod/tools' && (!init || init.method !== 'POST')) {
        toolsFetches += 1
        return {
          tools: [
            { ...TOOLS_FOR_CONN_1.tools[0], exposeToAi: toolsFetches > 1 },
            TOOLS_FOR_CONN_1.tools[1],
          ],
        }
      }
      if (path === '/mcp/connections/stripe-prod/tools/list_charges' && init?.method === 'POST') {
        return { ...TOOLS_FOR_CONN_1.tools[0], exposeToAi: true }
      }
      return EMPTY
    })
    render(<McpConnectionsPanel />)
    await waitFor(() => expect(screen.getByText('stripe-prod')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Show tools/i }))
    await waitFor(() => expect(screen.getByText('list_charges')).toBeInTheDocument())

    fireEvent.click(screen.getByLabelText('Expose list_charges description to AI'))

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(
        '/mcp/connections/stripe-prod/tools/list_charges',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ exposeToAi: true }),
        }),
      )
    })
    expect(useWorkflowStore.getState().platformVersion).toBe(1)
  })

  it('submits a stdio create-connection form and bumps platformVersion on success', async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/mcp/connections' && (!init || init.method !== 'POST')) return EMPTY
      if (path === '/mcp/connections' && init?.method === 'POST') {
        return { connection: ONE_CONNECTION.connections[0], tools: [], discovery: { ok: true, tools: 0 } }
      }
      return null
    })
    render(<McpConnectionsPanel />)
    await waitFor(() => expect(screen.getByText(/No MCP connections yet/i)).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Alias'), { target: { value: 'stripe-prod' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'node' } })
    fireEvent.change(screen.getByLabelText(/Args/), { target: { value: './srv.js' } })
    fireEvent.click(screen.getByRole('button', { name: /Register \+ discover/i }))
    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(
        '/mcp/connections',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"alias":"stripe-prod"'),
        }),
      )
    })
    expect(useWorkflowStore.getState().platformVersion).toBe(1)
  })
})
