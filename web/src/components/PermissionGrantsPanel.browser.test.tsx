import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { PermissionGrantsPanel } from './PermissionGrantsPanel'

vi.mock('../api', () => ({ api: vi.fn() }))

const CATALOG = {
  catalog: [{ key: 'workflows.read', category: 'workflows', description: 'View', defaultRoles: ['viewer'] }],
  mandatoryAdminPermissions: [],
}
const ROLES = { roles: [{ name: 'viewer', isBuiltin: true, inheritsFrom: 'viewer', description: null, grantedPermissions: null }] }

describe('<PermissionGrantsPanel /> (browser)', () => {
  it.each([[false, 'not-allowed'], [true, 'pointer']])('canWrite=%s shows the %s cursor on the cell', async (canWrite, cursor) => {
    vi.mocked(api).mockImplementation(async (path: string) => path === '/org/roles' ? ROLES : CATALOG)
    render(<PermissionGrantsPanel canWrite={canWrite} />)
    const label = (await screen.findByLabelText('viewer - workflows.read')).closest('label')!
    expect(getComputedStyle(label).cursor).toBe(cursor)
  })
})
