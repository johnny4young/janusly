import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { initI18n } from '../i18n'
import type { SessionContext } from '../identity-context'
import { useWorkflowStore } from '../store'
import { ToolApprovalPolicy } from './ToolApprovalPolicy'

vi.mock('../api', () => ({ api: vi.fn() }))

function signIn(permissions: string[]) {
  useWorkflowStore.setState({
    identityContext: {
      currentOrganizationId: 'org-1',
      organizations: [{ id: 'org-1', name: 'Org', plan: null, role: 'admin', roleBase: 'admin', permissions, usable: true, developmentFallback: false, isOwner: false }],
    } as unknown as SessionContext,
  })
}

beforeEach(() => {
  initI18n('en')
  vi.mocked(api).mockReset()
  vi.mocked(api).mockResolvedValue({ config: [{ key: 'tools.approvalRequired', value: 'slack.post' }] })
})

describe('<ToolApprovalPolicy />', () => {
  it('shows the workspace rule read-only to members who cannot change it', async () => {
    signIn(['workflows.write'])
    const { rerender } = render(<ToolApprovalPolicy tool="slack.post" />)
    expect(await screen.findByTestId('tool-approval-policy')).toHaveTextContent('Requires approval (workspace policy)')
    expect(screen.queryByTestId('tool-approval-policy-switch')).not.toBeInTheDocument()
    rerender(<ToolApprovalPolicy tool="text.uppercase" />)
    expect(screen.queryByTestId('tool-approval-policy')).not.toBeInTheDocument()
  })

  it('lets an admin add the tool to the workspace policy', async () => {
    signIn(['org.config.write'])
    render(<ToolApprovalPolicy tool="webhook.send" />)
    const toggle = await screen.findByTestId('tool-approval-policy-switch')
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    await waitFor(() => expect(api).toHaveBeenLastCalledWith('/org/config', {
      method: 'POST', body: JSON.stringify({ key: 'tools.approvalRequired', value: 'slack.post, webhook.send' }),
    }))
    await waitFor(() => expect(toggle).toBeChecked())
  })
})
