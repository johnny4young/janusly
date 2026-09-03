/** Real-Chromium layout smoke for truthful Recovery replay queue feedback. */

import { afterEach, describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { AppliedBody } from './AppliedBody'
import { changeRuntimeLocale } from '../../i18n'

afterEach(() => {
  changeRuntimeLocale('en')
})

describe('<AppliedBody /> replay queue state (browser smoke)', () => {
  it('lays out the queued cluster ribbon without terminal-recovery decoration', () => {
    const { getByRole, queryByTestId } = render(
      <AppliedBody cluster={{ replayed: 2, failed: 0, errors: [], downtimeEndedMs: 4_560_000 }} />,
    )

    const ribbon = getByRole('alert')
    expect(ribbon.textContent).toContain('Patch applied. Queued 2 of 2.')
    expect(ribbon.textContent).not.toContain('downtime ended')
    const rect = ribbon.getBoundingClientRect()
    expect(rect.height).toBeGreaterThan(0)
    expect(getComputedStyle(ribbon).display).not.toBe('none')
    expect(queryByTestId('celebration-burst')).toBeNull()
  })

  it('renders the terminal-verification state in Spanish without clipping', () => {
    changeRuntimeLocale('es')
    const { getByTestId } = render(
      <AppliedBody runId="run-12345678" playbookUsePending />,
    )

    const pending = getByTestId('recovery-playbook-use-pending')
    expect(pending.textContent).toContain('Uso del playbook pendiente de verificación')
    expect(pending.textContent).toContain('solo cuando este reintento termine correctamente')
    expect(pending.scrollWidth).toBeLessThanOrEqual(pending.clientWidth + 1)
    expect(pending.getBoundingClientRect().height).toBeGreaterThan(0)
  })
})
