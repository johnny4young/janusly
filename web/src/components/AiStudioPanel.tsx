/**
 * AI Studio is the governed, contract-first authoring surface.
 *
 * Authoring is intentionally split into four operations:
 * Intent Brief → Capability Binding → Proposal → explicit Apply.
 * A proposal never mutates the canvas. Apply only copies an exact, bound
 * proposal into an unsaved dirty draft; save, validate, and run stay separate.
 */
import { AiStudioFooter } from './ai-studio/AiStudioFooter'
import { AiStudioHero } from './ai-studio/AiStudioHero'
import { AuthoringStages } from './ai-studio/AuthoringStages'
import { CurrentWorkflowSection } from './ai-studio/CurrentWorkflowSection'
import type { AiStudioPanelProps } from './ai-studio/model'
import { useAiStudioController } from './ai-studio/useAiStudioController'

export function AiStudioPanel(props: AiStudioPanelProps) {
  const model = useAiStudioController(props)
  return (
    <div className="panel-stack">
      <AiStudioHero model={model} />
      <AuthoringStages model={model} />
      <CurrentWorkflowSection model={model} />
      <AiStudioFooter model={model} />
    </div>
  )
}
