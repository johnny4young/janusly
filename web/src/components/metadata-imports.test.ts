import { describe, expect, it, vi } from 'vitest'

// Metadata-only UI must not initialize unrelated request-body validators.
vi.mock('../lib/alert-policy', () => { throw new Error('Alert write contracts loaded') })
vi.mock('../lib/upstream-health', () => { throw new Error('Upstream write contracts loaded') })
vi.mock('../lib/recovery-item', () => { throw new Error('Recovery write contracts loaded') })
vi.mock('../lib/workflow-metadata', () => { throw new Error('Unrelated metadata collection validators loaded') })
vi.mock('../lib/workflow-snippets', () => { throw new Error('Snippet write contracts loaded') })
vi.mock('../lib/recovery-handoff', () => { throw new Error('Handoff write contracts loaded') })

describe('metadata-only UI imports', () => {
  it('loads snippet insertion without write validators', async () => {
    await expect(import('./SnippetInsertMenu')).resolves.toHaveProperty('SnippetInsertMenu')
  })
  it('loads alert policy controls without write validators', async () => {
    await expect(import('./AlertPoliciesPanel')).resolves.toHaveProperty('AlertPoliciesPanel')
  })
  it('loads upstream health controls without write validators', async () => {
    await expect(import('./UpstreamHealthPanel')).resolves.toHaveProperty('UpstreamHealthPanel')
  })
  it('loads handoff controls without write validators', async () => {
    await expect(import('./recovery-item/RecoveryHandoffSection')).resolves.toHaveProperty('RecoveryHandoffSection')
  })
  it('loads recovery controls without transition validators', async () => {
    await expect(import('./RecoveryItemDrawer')).resolves.toHaveProperty('RecoveryItemDrawer')
  })
  it('loads workflow metadata with its own validator, not recovery write validators', async () => {
    await expect(import('./WorkflowMetadataPanel')).resolves.toHaveProperty('WorkflowMetadataPanel')
  })
})
