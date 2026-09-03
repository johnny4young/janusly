import { useEffect, useRef, type ReactNode } from 'react'
import { ResilienceFieldset } from '@janusly/web'

/**
 * The retry / timeout / backoff controls shared by every step type that can
 * call something external. `nodeType` decides which controls apply — an
 * `agent` step exposes different knobs than a plain `http` one.
 *
 * The fieldset ships as a closed `<details>` summarising how many settings
 * are customised, so it does not crowd the editor. These cells open it, since
 * a card showing only "Resilience — 1 custom setting" teaches nothing.
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

/** An HTTP step with a full resilience policy. */
export function HttpStep() {
  return (
    <Opened>
      <ResilienceFieldset
        nodeId="fetch_invoice"
        nodeType="http"
        config={{ timeoutMs: 30000, maxAttempts: 3, backoffMs: 1000 }}
        onPatch={() => {}}
      />
    </Opened>
  )
}

/** A tool step left on the engine defaults. */
export function ToolStepDefaults() {
  return (
    <Opened>
      <ResilienceFieldset nodeId="ledger_adjust" nodeType="tool" config={{}} onPatch={() => {}} />
    </Opened>
  )
}

/** An agent step, where the model call carries a longer budget. */
export function AgentStep() {
  return (
    <Opened>
      <ResilienceFieldset
        nodeId="compare"
        nodeType="agent"
        config={{ timeoutMs: 120000, maxAttempts: 2, backoffMs: 5000 }}
        onPatch={() => {}}
      />
    </Opened>
  )
}

/** An MCP tool step. */
export function McpToolStep() {
  return (
    <Opened>
      <ResilienceFieldset
        nodeId="mcp_lookup"
        nodeType="mcp_tool"
        config={{ timeoutMs: 15000, maxAttempts: 1 }}
        onPatch={() => {}}
      />
    </Opened>
  )
}
