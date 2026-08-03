import type { ToolSchema } from '../types'
import { LazyToolInputFields } from './LazyToolInputFields'
import { JsonConfigField } from './quick-config-fields'

export function ToolInputEditor({
  scope,
  tool,
  input,
  rawLabel,
  onChange,
}: {
  scope: string
  tool?: ToolSchema
  input: unknown
  rawLabel: string
  onChange: (input: unknown) => void
}) {
  return tool
    ? <LazyToolInputFields scope={scope} tool={tool} input={input} onChange={onChange} />
    : <JsonConfigField scope={scope} label={rawLabel} value={input} onChange={onChange} />
}
