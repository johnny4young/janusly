/**
 * Real-Chromium coverage for Install contrast inside the global `.list-card` rules.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SolutionPackPublic } from '../types'
import { SolutionPacksPanel } from './SolutionPacksPanel'

const PACK: SolutionPackPublic = {
  id: 'failed-payment-recovery',
  name: 'Failed payment recovery',
  description: 'Draft a dunning outreach.',
  category: 'payment_recovery',
  version: '1.0.0',
  assurance: { intentContract: false, recoveryContractVersion: '', qualificationFixtureCount: 0 },
  requiredCredentials: [
    { name: 'billing_webhook', kind: 'http_bearer', purpose: 'Retries the charge' },
    { name: 'billing_slack', kind: 'slack_webhook', purpose: 'Notifies collections' },
  ],
  requiredOrgConfigs: [],
  nodeCount: 5,
  sampleCount: 0,
  failureCount: 0,
  samplePayloadIds: [],
  failureFixtureIds: [],
  failureFixtures: [],
}

function luminance(color: string): number {
  const channels = color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number)
  if (!channels || channels.length !== 3) throw new Error(`Expected an RGB color, received ${color}`)
  const [red, green, blue] = channels.map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return (0.2126 * red!) + (0.7152 * green!) + (0.0722 * blue!)
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (lighter! + 0.05) / (darker! + 0.05)
}

function renderPanel(theme: 'light' | 'dark', canInstall: boolean) {
  return render(
    <div data-theme={theme}>
      <SolutionPacksPanel
        packs={[PACK]}
        credentials={[]}
        canInstall={canInstall}
        onInstall={vi.fn()}
        onSampleRun={vi.fn()}
        onInjectFailure={vi.fn()}
      />
    </div>,
  )
}

describe('<SolutionPacksPanel /> Install contrast (browser)', () => {
  it.each([
    ['light', true],
    ['dark', true],
    ['light', false],
    ['dark', false],
  ] as const)('keeps the Install label and its note at 4.5:1 (%s, canInstall=%s)', (theme, canInstall) => {
    renderPanel(theme, canInstall)
    const button = screen.getByRole('button', { name: 'Install' })
    const label = button.querySelector('.ui-button__label')!
    const buttonBackground = getComputedStyle(button).backgroundColor
    expect(button).toHaveProperty('disabled', !canInstall)
    expect(contrast(getComputedStyle(label).color, buttonBackground)).toBeGreaterThanOrEqual(4.5)

    const note = screen.getByTestId(`pack-note-${PACK.id}`)
    const cardBackground = getComputedStyle(screen.getByTestId(`solution-pack-${PACK.id}`)).backgroundColor
    expect(note.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(contrast(getComputedStyle(note).color, cardBackground)).toBeGreaterThanOrEqual(4.5)
  })
})
