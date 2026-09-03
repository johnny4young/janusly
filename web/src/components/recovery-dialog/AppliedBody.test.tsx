/** Truthful enqueue-state coverage for the Recovery dialog applied step. */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AppliedBody } from './AppliedBody'


describe('<AppliedBody /> replay queue state', () => {
  it('names cluster members as queued without claiming recovery or downtime', () => {
    render(
      <AppliedBody cluster={{ replayed: 3, failed: 0, errors: [], downtimeEndedMs: 3_600_000 }} />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Patch applied. Queued 3 of 3.')
    expect(screen.queryByText(/Recovered|downtime ended/)).toBeNull()
    expect(screen.queryByTestId('celebration-burst')).toBeNull()
  })

  it('distinguishes rows that could not be queued', () => {
    render(
      <AppliedBody cluster={{
        replayed: 1,
        failed: 1,
        errors: [{ deadLetterId: 'dead-letter-2', error: 'already replayed' }],
      }} />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Queued 1 of 2; 1 could not be queued.')
  })

  it('names a single replay as queued', () => {
    render(<AppliedBody runId="run-12345678" />)

    expect(screen.getByRole('alert')).toHaveTextContent('Replay queued — run id run-1234…')
    expect(screen.queryByTestId('celebration-burst')).toBeNull()
  })

  it('keeps a playbook use pending until terminal recovery evidence exists', () => {
    render(<AppliedBody runId="run-12345678" playbookUsePending />)

    expect(screen.getByTestId('recovery-playbook-use-pending')).toHaveTextContent(
      'Playbook use awaiting verification',
    )
    expect(screen.getByTestId('recovery-playbook-use-pending')).toHaveTextContent(
      'only after this replay finishes successfully',
    )
    expect(screen.queryByTestId('recovery-playbook-use-recorded')).toBeNull()
    expect(screen.queryByText(/^1 successful production use$/i)).toBeNull()
  })
})
