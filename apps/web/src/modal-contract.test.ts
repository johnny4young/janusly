import { describe, expect, it } from 'vitest'

const sourceFiles = import.meta.glob(
  ['./**/*.tsx', '!./**/*.test.tsx'],
  { eager: true, import: 'default', query: '?raw' },
) as Record<string, string>

const MODAL_PROP = /^\s*aria-modal\s*=\s*([^\r\n]+)/gm

function canExposeTrueModal(source: string): boolean {
  return Array.from(source.matchAll(MODAL_PROP), (match) => match[1]?.trim())
    .some((value) => value !== '"false"' && value !== "'false'" && value !== '{false}')
}

const modalSources = Object.entries(sourceFiles)
  .filter(([, source]) => canExposeTrueModal(source))
  .sort(([left], [right]) => left.localeCompare(right))

describe('modal accessibility contract', () => {
  it('keeps the audited modal inventory explicit', () => {
    expect(modalSources.map(([path]) => path)).toEqual([
      './components/CommandPalette.tsx',
      './components/ConfirmDialog.tsx',
      './components/CredentialRotateModal.tsx',
      './components/RecoveryDialog.tsx',
      './components/ReplayCampaignDialog.tsx',
      './components/ReplayLabDialog.tsx',
      './components/ReplayLabForkDialog.tsx',
      './components/ReportDeliveryDialog.tsx',
      './components/RollbackConfirmDialog.tsx',
      './components/RunHistoryComparisonDialog.tsx',
      './components/RunInputDialog.tsx',
      './components/ShortcutsModal.tsx',
      './components/SnippetInsertMenu.tsx',
      './Layout.tsx',
    ])
  })

  it.each(modalSources)('%s uses the shared focus contract and an accessible name', (_path, source) => {
    expect(source).toMatch(/useDialogFocusTrap\s*\(/)
    expect(source).toMatch(/^\s*role\s*=/m)
    expect(source).toMatch(/^\s*aria-(?:label|labelledby)\s*=/m)
  })
})
