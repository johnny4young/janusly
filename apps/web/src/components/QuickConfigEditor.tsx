/**
 * Per-node-type config editor mounted inside the Inspector. A type-switch
 * with a branch per supported `nodeType`, dispatching to small per-branch
 * sub-forms. The `mcp_tool` branch delegates to `McpToolConfigField` for
 * the async connection / tool dropdown pair.
 *
 * Used by:
 * - `InspectorPanel.tsx` (rendered inside the per-node card).
 */

import React from 'react'
import type { JsonObject, ToolSchema } from '../types'
import { Trans, useT } from '../i18n'
import { McpToolConfigField } from './McpToolConfigField'
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

export function QuickConfigEditor({
  nodeId,
  type,
  config,
  tools,
  onUpdate,
}: {
  nodeId: string
  type: string
  config: JsonObject
  tools: ToolSchema[]
  onUpdate: (config: Record<string, unknown>) => void
}) {
  const { t } = useT()
  const patch = (next: Record<string, unknown>) => onUpdate({ ...config, ...next })

  if (type === 'http') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField scope={nodeId} label={t('rightPanel.quickConfig.requestUrl') as string} value={readConfigString(config, 'url')} onChange={value => patch({ url: value })} />
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
        <TextareaConfigField scope={nodeId} label={t('rightPanel.quickConfig.branchExpression') as string} value={readConfigString(config, 'expression')} onChange={value => patch({ expression: value })} />
      </section>
    )
  }

  if (type === 'subworkflow') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField scope={nodeId} label={t('rightPanel.quickConfig.workflowId') as string} value={readConfigString(config, 'workflowId')} onChange={value => patch({ workflowId: value })} />
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
      <McpToolConfigField
        scope={nodeId}
        config={config}
        onPatch={(next) => patch(next)}
      />
    )
  }

  if (type === 'schedule') {
    const enabled = config.enabled !== false
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField
          scope={nodeId}
          label={t('rightPanel.quickConfig.cronExpression') as string}
          value={readConfigString(config, 'cronExpression')}
          onChange={value => patch({ cronExpression: value })}
        />
        <div className="config-field-row">
          <label className="field-label" htmlFor={fieldId(nodeId, 'Enabled')}>{t('rightPanel.quickConfig.scheduleEnabled')}</label>
          <input
            id={fieldId(nodeId, 'Enabled')}
            type="checkbox"
            checked={enabled}
            onChange={event => patch({ enabled: event.target.checked })}
          />
        </div>
        <p className="helper-text">
          <Trans i18nKey="rightPanel.quickConfig.scheduleHelper" components={{ code: <code /> }} />
        </p>
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
