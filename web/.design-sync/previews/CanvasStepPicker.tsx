import { useEffect, useRef, type ReactNode } from 'react'
import { CanvasStepPicker } from '@janusly/web'

/**
 * The palette of step types an operator can drop onto the canvas. It takes
 * only `onAddNode` — the catalog itself is static, so this is the whole API.
 *
 * Closed it is just an "Add step" button, so these cells click it open. Unlike
 * `RecoveryAutomationDisclosure`, this popover is plain `useState` with no
 * lazy body, so the opened state captures cleanly.
 */
function Opened({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click()
  }, [])
  return <div ref={ref}>{children}</div>
}

/** The palette open, showing the step types on offer. */
export function Open() {
  return (
    <Opened>
      <CanvasStepPicker onAddNode={() => {}} />
    </Opened>
  )
}

/** Closed — the trigger as it sits on the canvas toolbar. */
export function Closed() {
  return <CanvasStepPicker onAddNode={() => {}} />
}
