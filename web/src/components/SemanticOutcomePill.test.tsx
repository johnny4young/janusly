import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SemanticOutcomePill } from './SemanticOutcomePill'
import type { RunSummary } from '../types'

describe('<SemanticOutcomePill />', () => {
  it('distinguishes a business outcome failure from technical run status', () => {
    render(
      <SemanticOutcomePill
        status="semantic_violation"
        testId="outcome"
      />,
    )
    expect(screen.getByTestId('outcome')).toHaveTextContent('Semantic failure')
    expect(screen.getByTestId('outcome')).toHaveAttribute(
      'data-outcome-status',
      'semantic_violation',
    )
    expect(screen.getByTestId('outcome')).toHaveAttribute(
      'data-tone',
      'warning',
    )
  })

  it('uses the blocking tone only for a quarantined outcome', () => {
    render(
      <SemanticOutcomePill
        status="semantic_quarantined"
        testId="quarantined"
      />,
    )
    expect(screen.getByTestId('quarantined')).toHaveAttribute(
      'data-tone',
      'danger',
    )
  })

  // A tone the stylesheet does not define renders as unstyled plain text, with
  // no error anywhere to catch it — which is how `semantic_violation` shipped
  // emitting `warn` while `.we-pill[data-tone="warning"]` was the only amber
  // rule. Assert every emitted tone against the real selector list rather than
  // against a hard-coded string, so the pair cannot drift apart again.
  it('only emits tones the pill stylesheet actually defines', () => {
    // vitest runs with cwd = the web package, and `import.meta.url` resolves
    // to a non-file URL behind Vite's transform — see `cold-load-polish.test.ts`.
    const css = readFileSync(resolve(process.cwd(), 'src/styles/platform.css'), 'utf8')
    const defined = new Set(
      [...css.matchAll(/\.we-pill\[data-tone="([a-z_]+)"\]/g)].map((match) => match[1]),
    )
    expect(defined.size).toBeGreaterThan(0)

    const statuses: NonNullable<RunSummary['outcomeStatus']>[] = [
      'semantic_violation',
      'semantic_quarantined',
      'semantic_recovering',
      'semantic_recovered',
      'semantic_accepted_loss',
    ]
    for (const status of statuses) {
      render(<SemanticOutcomePill status={status} testId={status} />)
      const tone = screen.getByTestId(status).getAttribute('data-tone')
      expect(defined).toContain(tone)
    }
  })
})
