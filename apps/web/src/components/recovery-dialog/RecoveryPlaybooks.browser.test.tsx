/** Real-Chromium layout proof for available and promotion playbook states. */

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { initI18n } from '../../i18n'
import { PlaybookMatchCard } from './PlaybookMatchCard'
import { PlaybookPromotionCard } from './PlaybookPromotionCard'
import type { RecoveryPlaybookSummary } from './types'

const playbook: RecoveryPlaybookSummary = {
  id: 'pb-browser', workflowId: 'wf-browser', signature: 'Network timeout on http node',
  version: 3, status: 'active', title: 'Recover billing dependency',
  instructionsMarkdown: 'Use the bounded timeout and verify the current dependency health.',
  approachLabel: 'raise_timeout', successfulUses: 4, regressions: 0,
  lastValidatedAt: '2026-07-11T10:00:00.000Z', activatedAt: '2026-07-11T10:01:00.000Z',
  retiredAt: null, createdAt: '2026-07-11T10:00:00.000Z', updatedAt: '2026-07-11T10:01:00.000Z',
}

describe('Recovery Playbooks (browser smoke)', () => {
  afterEach(() => initI18n('en'))

  it('lays out the explicit-use gate in English', async () => {
    render(<PlaybookMatchCard playbook={playbook} busy={null} onUse={vi.fn()} onRetire={vi.fn()} />)
    const card = await screen.findByTestId('recovery-playbook-match')
    expect(card).toHaveTextContent('Recover billing dependency')
    expect(card).toHaveTextContent('This playbook never runs automatically')
    expect(screen.getByRole('button', { name: 'Use and revalidate' })).toBeVisible()
    expect(card.getBoundingClientRect().height).toBeGreaterThan(120)
  })

  it('lays out the manual promotion entry point in Spanish', async () => {
    initI18n('es')
    render(<PlaybookPromotionCard source={{
      deadLetterId: 'dlq-browser', validationRunId: 'validation-browser', sourceWorkflowVersionId: 'wv-browser',
      defaultTitle: 'Recuperación de fetch', defaultInstructions: 'Usa el timeout acotado.',
    }} />)
    const card = await screen.findByTestId('recovery-playbook-promotion')
    expect(card).toHaveTextContent('Convierte esta recuperación en un playbook')
    expect(screen.getByRole('button', { name: 'Crear playbook' })).toBeVisible()
    expect(card.getBoundingClientRect().height).toBeGreaterThan(80)
  })
})
