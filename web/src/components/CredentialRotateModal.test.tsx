import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { CredentialRotateModal } from './CredentialRotateModal'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

function renderWithDryRun(affected: unknown) {
  vi.mocked(api).mockResolvedValue({
    credentialName: 'demo-slack', kind: 'slack', updatedAt: '2026-11-04T13:12:08.676Z', affected, affectedCount: 1,
  })
  render(
    <CredentialRotateModal
      credentialName="demo-slack"
      workflows={[{ id: 'wf-1', name: 'Incident triage' }]}
      onClose={vi.fn()}
    />,
  )
}

beforeEach(() => {
  vi.mocked(api).mockReset()
})

describe('<CredentialRotateModal />', () => {
  it('previews the workflow ids the dry run returns, by name', async () => {
    renderWithDryRun(['wf-1', 'wf-unlisted'])

    expect(await screen.findByRole('heading', { name: 'Affected workflows (2)' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      'Incident triage',
      'wf-unlisted',
    ])
  })

  it('reports an error instead of crashing on a malformed preview', async () => {
    renderWithDryRun([{ workflowId: 'wf-1' }])

    expect(await screen.findByRole('alert')).toHaveTextContent('Rotation failed. Try previewing again.')
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })
})
