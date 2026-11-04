import { useEffect } from 'react'

import { useT } from '../i18n'
import type { RunSummary } from '../types'
import { FormField, SelectControl } from './ui/Form'

/** Newest failed run first, so opening Run events lands on something to debug. */
function defaultRun(runs: readonly RunSummary[]): RunSummary | undefined {
  return runs.find((run) => run.status === 'failed') ?? runs[0]
}

export function RunEventsPicker({
  runs,
  activeRunId,
  onSelectRun,
}: {
  runs: readonly RunSummary[]
  activeRunId?: string | null
  onSelectRun: (id: string) => void
}) {
  const { t } = useT()
  const initialRunId = activeRunId ? null : defaultRun(runs)?.id

  useEffect(() => {
    if (initialRunId) onSelectRun(initialRunId)
  }, [initialRunId, onSelectRun])

  if (runs.length === 0) return null
  return (
    <FormField label={t('rightPanel.reasoning.runPicker')} id="run-events-picker">
      {(controlProps) => (
        <SelectControl
          {...controlProps}
          value={activeRunId ?? ''}
          onChange={(event) => onSelectRun(event.target.value)}
          data-testid="run-events-picker"
        >
          {!activeRunId && <option value="" />}
          {runs.map((run) => (
            <option key={run.id} value={run.id}>
              {`${run.workflowName ?? run.workflowId ?? t('home.active.unknownWorkflow')} · ${t(`status.${run.status}`)} · ${run.id.slice(0, 8)}`}
            </option>
          ))}
        </SelectControl>
      )}
    </FormField>
  )
}
