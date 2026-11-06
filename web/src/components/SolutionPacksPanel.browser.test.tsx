/**
 * Real-Chromium coverage for Install contrast inside the global `.list-card` rules.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from 'vitest/browser'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Credential, SolutionPackPublic } from '../types'
import { SolutionPacksPanel } from './SolutionPacksPanel'

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  api: vi.fn(async () => ({ managedStorageAvailable: true, credentials: [] })),
}))

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

function renderPanel(theme: 'light' | 'dark', canInstall: boolean, credentials: Credential[] = [], credentialsKnown = true) {
  return render(
    <div data-theme={theme}>
      <SolutionPacksPanel
        packs={[PACK]}
        credentials={credentials}
        credentialsKnown={credentialsKnown}
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

  it.each(['light', 'dark'] as const)('keeps a primary Install and each row state at 4.5:1 (%s)', (theme) => {
    // On the root, as in the app: semantic text tokens resolve there and only inherit.
    document.documentElement.dataset.theme = theme
    onTestFinished(() => { delete document.documentElement.dataset.theme })
    renderPanel(theme, true, [{ id: 'cred-1', name: 'billing_webhook', kind: 'http_bearer' }])
    const cardBackground = getComputedStyle(screen.getByTestId(`solution-pack-${PACK.id}`)).backgroundColor
    const expectReadableRows = () => {
      for (const name of ['billing_webhook', 'billing_slack']) {
        const row = screen.getByText(name).closest('li')!
        for (const part of [row.querySelector('code')!, row.querySelector('span')!, row.querySelector('svg')!]) {
          expect(contrast(getComputedStyle(part).color, cardBackground)).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
    expectReadableRows()

    cleanup()
    renderPanel(theme, true, [], false)
    expect(screen.getByText('billing_slack').closest('li')).toHaveProperty('dataset.state', 'unknown')
    expectReadableRows()

    cleanup()
    renderPanel(theme, true, PACK.requiredCredentials.map((cred) => ({ id: cred.name, name: cred.name, kind: cred.kind })))
    const button = screen.getByTestId(`pack-install-${PACK.id}`)
    expect(button.className).toContain('ui-button--primary')
    expect(contrast(
      getComputedStyle(button.querySelector('.ui-button__label')!).color,
      getComputedStyle(button).backgroundColor,
    )).toBeGreaterThanOrEqual(4.5)
  })
})

describe('<SolutionPacksPanel /> Connect focus (browser)', () => {
  it('keeps Tab inside the dialog while a create is in flight and after it fails', async () => {
    let finishCreate = (_created: boolean) => {}
    const created = new Promise<boolean>((resolve) => { finishCreate = resolve })
    render(
      <>
        <button type="button" data-testid="behind">Behind</button>
        <SolutionPacksPanel
          packs={[PACK]}
          credentials={[]}
          onInstall={vi.fn()}
          onSampleRun={vi.fn()}
          onInjectFailure={vi.fn()}
          onCreateCredential={() => created}
        />
      </>,
    )
    onTestFinished(cleanup)
    const focusInDialog = () => screen.getByRole('dialog').contains(document.activeElement)

    screen.getByTestId('pack-connect-failed-payment-recovery-billing_slack').click()
    const secret = await screen.findByLabelText(/^Secret value/)
    await waitFor(() => expect(document.activeElement).toBe(secret))
    await userEvent.keyboard('hunter2{Enter}')

    await waitFor(() => expect(secret.matches(':disabled')).toBe(true))
    await userEvent.tab()
    expect(focusInDialog(), `in flight, focus was on ${document.activeElement?.tagName}`).toBe(true)

    finishCreate(false)
    await waitFor(() => expect(secret.matches(':disabled')).toBe(false))
    await waitFor(() => expect(document.activeElement).toBe(secret))
    await userEvent.tab()
    expect(focusInDialog(), `after failure, focus was on ${document.activeElement?.tagName}`).toBe(true)
  })
})
