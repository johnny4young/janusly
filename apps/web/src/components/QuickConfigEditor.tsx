/**
 * Per-node-type config editor mounted inside the Inspector. A type-switch
 * with a branch per supported `nodeType`, dispatching to small per-branch
 * sub-forms. The `mcp_tool` branch delegates to `McpToolConfigField` for
 * the async connection / tool dropdown pair.
 *
 * Used by:
 * - `InspectorPanel.tsx` (rendered inside the per-node card).
 */

import { useCallback, useState } from 'react'
import type { JsonObject, SavedWorkflow, ToolSchema, WorkflowGraphEdge, WorkflowGraphNode, WorkflowInputSchemaShape } from '../types'
import { Trans, useT } from '../i18n'
import { McpToolConfigField } from './McpToolConfigField'
import { ResilienceFieldset } from './ResilienceFieldset'
import { ExpressionAssistant } from './ExpressionAssistant'
import { ScheduleCronPreview } from './ScheduleCronPreview'
import type { ScheduleCronPreviewSnapshot } from './ScheduleCronPreview'
import {
  asJsonObject,
  fieldId,
  JsonConfigField,
  NumberConfigField,
  readConfigNumber,
  readConfigString,
  TextareaConfigField,
  TextConfigField,
} from './quick-config-fields'

function ScheduleConfigFields({ nodeId, config, onPatch }: {
  nodeId: string
  config: JsonObject
  onPatch: (next: Record<string, unknown>) => void
}) {
  const { t } = useT()
  const [preview, setPreview] = useState<ScheduleCronPreviewSnapshot | null>(null)
  const enabled = config.enabled !== false
  const cronExpression = readConfigString(config, 'cronExpression')
  const normalizedExpression = cronExpression.trim()
  const cronId = fieldId(nodeId, 'cron expression')
  const cronHelperId = `${cronId}-helper`
  const cronPreviewId = `${cronId}-preview`
  const invalid = enabled
    && normalizedExpression.length > 0
    && preview?.expression === normalizedExpression
    && preview.kind === 'invalid'
  const handlePreviewState = useCallback((next: ScheduleCronPreviewSnapshot) => {
    setPreview(previous => previous?.expression === next.expression && previous.kind === next.kind ? previous : next)
  }, [])

  return (
    <section className="quick-config">
      <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
      <div className="config-field-row">
        <label className="field-label" htmlFor={cronId}>{t('rightPanel.quickConfig.cronExpression')}</label>
        <input
          id={cronId}
          className="text-field"
          value={cronExpression}
          maxLength={100}
          aria-describedby={`${cronHelperId} ${cronPreviewId}`}
          aria-invalid={invalid || undefined}
          aria-errormessage={invalid ? cronPreviewId : undefined}
          onChange={event => onPatch({ cronExpression: event.target.value })}
        />
        <p id={cronHelperId} className="helper-text">
          <Trans i18nKey="rightPanel.quickConfig.scheduleHelper" components={{ code: <code /> }} />
        </p>
        <ScheduleCronPreview
          id={cronPreviewId}
          expression={cronExpression}
          enabled={enabled}
          onStateChange={handlePreviewState}
        />
      </div>
      <div className="config-field-row">
        <label className="field-label" htmlFor={fieldId(nodeId, 'Enabled')}>{t('rightPanel.quickConfig.scheduleEnabled')}</label>
        <input
          id={fieldId(nodeId, 'Enabled')}
          type="checkbox"
          checked={enabled}
          onChange={event => onPatch({ enabled: event.target.checked })}
        />
      </div>
    </section>
  )
}

export function QuickConfigEditor({
  nodeId,
  type,
  config,
  tools,
  workflowNodes,
  workflowEdges,
  workflowInputs,
  workflows = [],
  currentWorkflowId,
  onUpdate,
}: {
  nodeId: string
  type: string
  config: JsonObject
  tools: ToolSchema[]
  workflowNodes: WorkflowGraphNode[]
  workflowEdges: WorkflowGraphEdge[]
  workflowInputs?: WorkflowInputSchemaShape
  workflows?: Array<Pick<SavedWorkflow, 'id' | 'name'>>
  currentWorkflowId?: string
  onUpdate: (config: Record<string, unknown>) => void
}) {
  const { t } = useT()
  const patch = (next: Record<string, unknown>) => onUpdate({ ...config, ...next })

  if (type === 'http') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField scope={nodeId} label={t('rightPanel.quickConfig.requestUrl') as string} value={readConfigString(config, 'url')} onChange={value => patch({ url: value })} />
        <ResilienceFieldset nodeId={nodeId} nodeType="http" config={config} onPatch={patch} />
      </section>
    )
  }

  if (type === 'ai') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextareaConfigField scope={nodeId} label={t('rightPanel.quickConfig.prompt') as string} value={readConfigString(config, 'prompt')} onChange={value => patch({ prompt: value })} />
      </section>
    )
  }

  if (type === 'tool') {
    const selectedTool = readConfigString(config, 'tool')
    const matchedTool = tools.find(tool => tool.name === selectedTool) ?? null
    const showCurrentToolOption = Boolean(selectedTool) && !matchedTool
    const isUnknown = showCurrentToolOption && tools.length > 0
    const toolNameId = fieldId(nodeId, 'tool name')
    const onSelectTool = (next: string) => {
      // Switching tools clobbers the input only when it's empty — preserves
      // any edits the author already made on the previous tool's payload.
      const inputIsEmpty = !config.input || (typeof config.input === 'object' && config.input !== null && !Array.isArray(config.input) && Object.keys(config.input).length === 0)
      const newTool = tools.find(tool => tool.name === next)
      const seedInput = inputIsEmpty && newTool?.inputExample ? newTool.inputExample : config.input
      patch({ tool: next, input: seedInput })
    }
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <div className="form-grid">
          <label className="field-label" htmlFor={toolNameId}>{t('rightPanel.quickConfig.tool')}</label>
          <select
            id={toolNameId}
            className="text-field"
            value={selectedTool}
            onChange={event => onSelectTool(event.target.value)}
          >
            {!selectedTool && <option value="">{t('rightPanel.quickConfig.pickTool')}</option>}
            {showCurrentToolOption && <option value={selectedTool}>{tools.length > 0 ? t('rightPanel.quickConfig.toolNotRegistered', { name: selectedTool }) : t('rightPanel.quickConfig.toolLoading', { name: selectedTool })}</option>}
            {tools.map(tool => (
              <option key={tool.name} value={tool.name}>{tool.name}</option>
            ))}
          </select>
          {matchedTool?.description && <p className="helper-text">{matchedTool.description}</p>}
          {matchedTool?.required && matchedTool.required.length > 0 && (
            <p className="helper-text">{t('rightPanel.quickConfig.requiredInput', { required: matchedTool.required.join(', ') })}{matchedTool.optional?.length ? t('rightPanel.quickConfig.optionalSuffix', { optional: matchedTool.optional.join(', ') }) : ''}</p>
          )}
          {isUnknown && <p className="helper-text" data-testid="unknown-tool-warning">{t('rightPanel.quickConfig.unknownToolWarning')}</p>}
        </div>
        <JsonConfigField scope={nodeId} label={t('rightPanel.quickConfig.toolInput') as string} value={asJsonObject(config.input)} onChange={value => patch({ input: value })} />
        <ResilienceFieldset nodeId={nodeId} nodeType="tool" config={config} onPatch={patch} />
      </section>
    )
  }

  if (type === 'agent' || type === 'multi_agent') {
    const plannerId = fieldId(nodeId, `${type} planner`)
    const teamModeId = fieldId(nodeId, 'team mode')
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextareaConfigField scope={nodeId} label={type === 'multi_agent' ? (t('rightPanel.quickConfig.teamGoal') as string) : (t('rightPanel.quickConfig.agentGoal') as string)} value={readConfigString(config, 'goal')} onChange={value => patch({ goal: value })} />
        <div className="config-field-row">
          <label className="field-label" htmlFor={plannerId}>{t('rightPanel.quickConfig.planner')}</label>
          <select id={plannerId} className="text-field" value={readConfigString(config, 'planner') || 'rules'} onChange={event => patch({ planner: event.target.value })}>
            <option value="rules">{t('rightPanel.quickConfig.plannerRules')}</option>
            <option value="openai">{t('rightPanel.quickConfig.plannerOpenai')}</option>
          </select>
        </div>
        {type === 'multi_agent' && (
          <div className="config-field-row">
            <label className="field-label" htmlFor={teamModeId}>{t('rightPanel.quickConfig.teamMode')}</label>
            <select id={teamModeId} className="text-field" value={readConfigString(config, 'mode') || 'sequential'} onChange={event => patch({ mode: event.target.value })}>
              <option value="sequential">{t('rightPanel.quickConfig.teamModeSequential')}</option>
              <option value="parallel">{t('rightPanel.quickConfig.teamModeParallel')}</option>
            </select>
          </div>
        )}
        {type === 'agent' && <TextConfigField scope={nodeId} label={t('rightPanel.quickConfig.inputValue') as string} value={readConfigString(config, 'value')} onChange={value => patch({ value })} />}
        <NumberConfigField scope={nodeId} label={t('rightPanel.quickConfig.maxSteps') as string} value={readConfigNumber(config, 'maxSteps') ?? 3} onChange={value => patch({ maxSteps: value })} />
        {type === 'multi_agent' && (
          <label className="checkbox-row">
            <input type="checkbox" checked={config.reflection !== false} onChange={event => patch({ reflection: event.target.checked })} />
            <span>{t('rightPanel.quickConfig.reflection')}</span>
          </label>
        )}
        {type === 'agent' && <ResilienceFieldset nodeId={nodeId} nodeType="agent" config={config} onPatch={patch} />}
      </section>
    )
  }

  if (type === 'approval') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextareaConfigField scope={nodeId} label={t('rightPanel.quickConfig.approvalMessage') as string} value={readConfigString(config, 'message')} onChange={value => patch({ message: value })} />
      </section>
    )
  }

  if (type === 'human_form') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField scope={nodeId} label={t('rightPanel.quickConfig.formTitle') as string} value={readConfigString(config, 'title')} onChange={value => patch({ title: value })} />
        <TextareaConfigField scope={nodeId} label={t('rightPanel.quickConfig.formInstructions') as string} value={readConfigString(config, 'description')} onChange={value => patch({ description: value })} />
        <JsonConfigField scope={nodeId} label={t('rightPanel.quickConfig.fieldsSchema') as string} value={asJsonObject(config.schema)} onChange={value => patch({ schema: value })} />
        <p className="helper-text">{t('rightPanel.quickConfig.humanFormHelper')}</p>
      </section>
    )
  }

  if (type === 'condition') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <ExpressionAssistant
          id={`${nodeId}-branch-expression`}
          label={t('rightPanel.quickConfig.branchExpression') as string}
          value={readConfigString(config, 'expression')}
          onChange={value => patch({ expression: value })}
          nodes={workflowNodes}
          edges={workflowEdges}
          targetNodeId={nodeId}
          mode="node"
          workflowInputs={workflowInputs}
        />
      </section>
    )
  }

  if (type === 'subworkflow') {
    const selectedWorkflowId = readConfigString(config, 'workflowId')
    const choices = workflows.filter(workflow => workflow.id !== currentWorkflowId)
    const workflowId = fieldId(nodeId, 'subworkflow workflow')
    const workflowListId = `${workflowId}-choices`
    const workflowHelperId = `${workflowId}-helper`
    const isSelfReference = Boolean(selectedWorkflowId && currentWorkflowId && selectedWorkflowId === currentWorkflowId)
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <div className="config-field-row">
          <label className="field-label" htmlFor={workflowId}>{t('rightPanel.quickConfig.workflowId')}</label>
          <input
            id={workflowId}
            className="text-field"
            list={workflowListId}
            value={selectedWorkflowId}
            placeholder={t('rightPanel.quickConfig.pickWorkflow') as string}
            autoComplete="off"
            aria-describedby={workflowHelperId}
            aria-invalid={isSelfReference || undefined}
            aria-errormessage={isSelfReference ? workflowHelperId : undefined}
            onChange={event => patch({ workflowId: event.target.value })}
          />
          <datalist id={workflowListId}>
            {choices.map(workflow => (
              <option
                key={workflow.id}
                value={workflow.id}
                label={t('rightPanel.quickConfig.workflowOption', { name: workflow.name, id: workflow.id }) as string}
              />
            ))}
          </datalist>
          <p id={workflowHelperId} className={isSelfReference ? 'helper-text helper-text--error' : 'helper-text'}>
            {isSelfReference
              ? t('rightPanel.quickConfig.subworkflowSelfReference')
              : choices.length > 0
                ? t('rightPanel.quickConfig.subworkflowHelper')
                : t('rightPanel.quickConfig.noSubworkflowChoices')}
          </p>
        </div>
        <JsonConfigField scope={nodeId} label={t('rightPanel.quickConfig.overrideInput') as string} value={asJsonObject(config.input)} onChange={value => patch({ input: value })} />
      </section>
    )
  }

  if (type === 'wait_until') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField scope={nodeId} label={t('rightPanel.quickConfig.duration') as string} value={readConfigString(config, 'duration')} onChange={value => patch({ duration: value })} />
        <p className="helper-text">
          <Trans i18nKey="rightPanel.quickConfig.durationHelper" components={{ code: <code /> }} />
        </p>
      </section>
    )
  }

  if (type === 'loop') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField scope={nodeId} label={t('rightPanel.quickConfig.items') as string} value={readConfigString(config, 'items')} onChange={value => patch({ items: value })} />
        <JsonConfigField scope={nodeId} label={t('rightPanel.quickConfig.itemMapping') as string} value={asJsonObject(config.mapping)} onChange={value => patch({ mapping: value })} />
      </section>
    )
  }

  if (type === 'transform') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <JsonConfigField scope={nodeId} label={t('rightPanel.quickConfig.fieldMapping') as string} value={asJsonObject(config.mapping)} onChange={value => patch({ mapping: value })} />
      </section>
    )
  }

  if (type === 'router' || type === 'router_llm') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <JsonConfigField scope={nodeId} label={t('rightPanel.quickConfig.candidates') as string} value={Array.isArray(config.candidates) ? config.candidates : []} onChange={value => patch({ candidates: value })} />
      </section>
    )
  }

  if (type === 'parallel_fork') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <JsonConfigField
          scope={nodeId}
          label={t('rightPanel.quickConfig.branches') as string}
          value={Array.isArray(config.branches) ? config.branches : []}
          onChange={value => patch({ branches: value })}
        />
        <p className="helper-text">
          <Trans i18nKey="rightPanel.quickConfig.branchesHelper" components={{ code: <code /> }} />
        </p>
      </section>
    )
  }

  if (type === 'join') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <JsonConfigField
          scope={nodeId}
          label={t('rightPanel.quickConfig.branchSources') as string}
          value={asJsonObject(config.sources)}
          onChange={value => patch({ sources: value })}
        />
        <p className="helper-text">
          <Trans i18nKey="rightPanel.quickConfig.branchSourcesHelper" components={{ code: <code /> }} />
        </p>
      </section>
    )
  }

  if (type === 'mcp_tool') {
    return (
      <>
        <McpToolConfigField
          scope={nodeId}
          config={config}
          onPatch={(next) => patch(next)}
        />
        <ResilienceFieldset nodeId={nodeId} nodeType="mcp_tool" config={config} onPatch={patch} />
      </>
    )
  }

  if (type === 'schedule') {
    return <ScheduleConfigFields nodeId={nodeId} config={config} onPatch={patch} />
  }

  if (type === 'email_received') {
    const dkimRequired = config.dkimRequired !== false
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField
          scope={nodeId}
          label={t('rightPanel.quickConfig.emailAliasKey') as string}
          value={readConfigString(config, 'aliasKey')}
          onChange={value => patch({ aliasKey: value })}
        />
        <div className="config-field-row">
          <label className="field-label" htmlFor={fieldId(nodeId, 'DkimRequired')}>{t('rightPanel.quickConfig.emailDkimRequired')}</label>
          <input
            id={fieldId(nodeId, 'DkimRequired')}
            type="checkbox"
            checked={dkimRequired}
            onChange={event => patch({ dkimRequired: event.target.checked })}
          />
        </div>
        <p className="helper-text">{t('rightPanel.quickConfig.emailReceivedHelper')}</p>
      </section>
    )
  }

  if (type === 'file_dropped') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField
          scope={nodeId}
          label={t('rightPanel.quickConfig.fileBucket') as string}
          value={readConfigString(config, 'bucket')}
          onChange={value => patch({ bucket: value })}
        />
        <TextConfigField
          scope={nodeId}
          label={t('rightPanel.quickConfig.filePrefix') as string}
          value={readConfigString(config, 'prefix')}
          onChange={value => patch({ prefix: value })}
        />
        <p className="helper-text">{t('rightPanel.quickConfig.fileDroppedHelper')}</p>
      </section>
    )
  }

  if (type === 'mcp_server_event') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField
          scope={nodeId}
          label={t('rightPanel.quickConfig.mcpEventConnectionAlias') as string}
          value={readConfigString(config, 'connectionAlias')}
          onChange={value => patch({ connectionAlias: value })}
        />
        <TextConfigField
          scope={nodeId}
          label={t('rightPanel.quickConfig.mcpEventResourceUri') as string}
          value={readConfigString(config, 'resourceUri')}
          onChange={value => patch({ resourceUri: value })}
        />
        <p className="helper-text">{t('rightPanel.quickConfig.mcpServerEventHelper')}</p>
      </section>
    )
  }

  return (
    <section className="quick-config">
      <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
      <p className="empty-state">{t('rightPanel.quickConfig.noSetup')}</p>
    </section>
  )
}
