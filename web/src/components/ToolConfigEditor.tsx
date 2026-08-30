import { useT } from '../i18n'
import type { JsonObject, ToolSchema } from '../types'
import { readConfigString } from './quick-config-fields'
import { ResilienceFieldset } from './ResilienceFieldset'
import { ToolInputEditor } from './ToolInputEditor'
import { ToolPicker } from './ToolPicker'
import { Button } from './ui/Button'
import { FormActions } from './ui/Form'

export function ToolConfigEditor({
  nodeId,
  config,
  tools,
  onUpdate,
}: {
  nodeId: string
  config: JsonObject
  tools: ToolSchema[]
  onUpdate: (config: Record<string, unknown>) => void
}) {
  const { t } = useT()
  const selectedTool = readConfigString(config, 'tool')
  const matchedTool = tools.find(tool => tool.name === selectedTool)
  const patch = (next: Record<string, unknown>) => onUpdate({ ...config, ...next })

  return (
    <section className="quick-config" data-testid="tool-config">
      <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
      <ToolPicker
        nodeId={nodeId}
        selectedTool={selectedTool}
        tools={tools}
        onChange={(tool, input) => patch({ tool, input })}
      />
      {selectedTool && (
        <>
          <ToolInputEditor
            scope={nodeId}
            tool={matchedTool}
            input={config.input}
            rawLabel={t('rightPanel.quickConfig.toolInput')}
            onChange={input => patch({ input })}
          />
          {matchedTool?.inputExample && (
            <FormActions>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => patch({ input: matchedTool.inputExample })}
              >
                {t('rightPanel.quickConfig.toolRestoreExample')}
              </Button>
            </FormActions>
          )}
          <p className="helper-text">{t('rightPanel.quickConfig.toolChangeHelper')}</p>
        </>
      )}
      <ResilienceFieldset
        nodeId={nodeId}
        nodeType="tool"
        config={config}
        onPatch={patch}
      />
    </section>
  )
}
