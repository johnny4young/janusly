import { useEffect, useRef, type ReactNode } from 'react'
import { AlternativeHypothesesPanel } from '@janusly/web'

/**
 * The alternatives the patch model considered and rejected, so the reasoning
 * behind a suggestion is auditable. Renders nothing when the list normalizes
 * to empty — the panel never shows an empty shell.
 *
 * Like `EvidencePanel` this is a `<details>` that ships closed; these cells
 * open it so the card shows the rejected approaches, not just the count.
 */
function Opened({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelectorAll('details').forEach((d) => {
      d.open = true
    })
  }, [])
  return <div ref={ref}>{children}</div>
}

/** Several rejected approaches, each with its reason. */
export function SeveralRejected() {
  return (
    <Opened>
      <AlternativeHypothesesPanel
        alternatives={[
          {
            approach: 'add_retry',
            rejectedBecause:
              'The step already retries twice; a third attempt lands inside the same maintenance window and fails identically.',
          },
          {
            approach: 'swap_secret_ref',
            rejectedBecause:
              'The credential was rotated 40 days ago and every other step using it succeeded in the same run.',
          },
          {
            approach: 'fix_url',
            rejectedBecause:
              'The host resolved and returned 503 — the URL is reachable and correct.',
          },
        ]}
      />
    </Opened>
  )
}

/** A single alternative — the minimum the panel renders for. */
export function SingleAlternative() {
  return (
    <Opened>
      <AlternativeHypothesesPanel
        alternatives={[
          {
            approach: 'add_approval',
            rejectedBecause: 'A human gate would not have prevented an upstream timeout.',
          },
        ]}
      />
    </Opened>
  )
}
