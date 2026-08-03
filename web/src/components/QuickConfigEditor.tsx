/**
 * Per-node-type config editor mounted inside the Inspector. A type-switch
 * with a branch per supported `nodeType`, dispatching to small per-branch
 * sub-forms. The `mcp_tool` branch delegates to `McpToolConfigField` for
 * the async connection / tool dropdown pair.
 *
 * Used by:
 * - `InspectorPanel.tsx` (rendered inside the per-node card).
 */

import { useEffect, useState } from 'react'
import { publicApiUrl } from '../api'
import type { JsonObject, SavedWorkflow, ToolSchema, WorkflowGraphEdge, WorkflowGraphNode, WorkflowInputSchemaShape } from '../types'
import { Trans, useT } from '../i18n'
import { McpToolConfigField } from './McpToolConfigField'
import { ResilienceFieldset } from './ResilienceFieldset'
import { BranchRuleEditor } from './BranchRuleEditor'
import { HttpConfigEditor } from './HttpConfigEditor'
import { AiConfigEditor } from './AiConfigEditor'
import { ToolConfigEditor } from './ToolConfigEditor'
import { ToolInputEditor } from './ToolInputEditor'
import { ToolPicker } from './ToolPicker'
import {
  ApprovalConfigEditor,
  HumanFormConfigEditor,
  ScheduleConfigEditor,
  WaitUntilConfigEditor,
} from './TimingConfigEditors'
import {
  asJsonObject,
  fieldId,
  JsonConfigField,
  NumberConfigField,
  OptionalNumberConfigField,
  readConfigNumber,
  readConfigString,
  TextareaConfigField,
  TextConfigField,
} from './quick-config-fields'

// Mirrors `src/lib.workflowVersionMax` without importing the runtime
// barrel into this lazy authoring chunk and perturbing the production split.
const SUBWORKFLOW_VERSION_MAX = 2_147_483_647
const LOOP_DEFAULT_CONCURRENCY = 4
const LOOP_MAX_CONCURRENCY = 20

function isPositiveVersion(value: string): boolean {
  if (!/^\d+$/.test(value)) return false
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= SUBWORKFLOW_VERSION_MAX
}

function SubworkflowVersionField({ nodeId, value, onChange }: {
  nodeId: string
  value: unknown
  onChange: (version: number | string | undefined) => void
}) {
  const { t } = useT()
  const renderedValue = value === undefined ? '' : String(value)
  const [draft, setDraft] = useState(renderedValue)
  const [invalid, setInvalid] = useState(Boolean(renderedValue) && !isPositiveVersion(renderedValue))
  const id = fieldId(nodeId, 'subworkflow version')
  const helperId = `${id}-helper`

  useEffect(() => {
    setDraft(renderedValue)
    setInvalid(Boolean(renderedValue) && !isPositiveVersion(renderedValue))
  }, [nodeId, renderedValue])

  const commit = () => {
    const normalized = draft.trim()
    if (!normalized) {
      setInvalid(false)
      setDraft('')
      if (value !== undefined) onChange(undefined)
      return
    }
    if (!isPositiveVersion(normalized)) {
      setInvalid(true)
      if (value !== normalized) onChange(normalized)
      return
    }
    const version = Number(normalized)
    setInvalid(false)
    setDraft(String(version))
    if (value !== version) onChange(version)
  }

  return (
    <div className="config-field-row" data-testid="subworkflow-version-field">
      <label className="field-label" htmlFor={id}>{t('rightPanel.quickConfig.subworkflowVersion')}</label>
      <input
        id={id}
        className={`text-field${invalid ? ' text-field--error' : ''}`}
        type="number"
        inputMode="numeric"
        min="1"
        max={SUBWORKFLOW_VERSION_MAX}
        step="1"
        value={draft}
        placeholder={t('rightPanel.quickConfig.subworkflowVersionPlaceholder')}
        aria-describedby={helperId}
        aria-invalid={invalid || undefined}
        aria-errormessage={invalid ? helperId : undefined}
        onChange={event => {
          const next = event.target.value
          const normalized = next.trim()
          const nextInvalid = Boolean(normalized) && !isPositiveVersion(normalized)
          setDraft(next)
          setInvalid(nextInvalid)
          if (nextInvalid) {
            // Keep malformed authoring in the canonical workflow draft so
            // global validation blocks Cmd/Ctrl+S instead of saving the last
            // valid version hidden behind this local input state.
            if (value !== normalized) onChange(normalized)
            return
          }
          if (!normalized) {
            if (value !== undefined) onChange(undefined)
            return
          }
          const version = Number(normalized)
          if (value !== version) onChange(version)
        }}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
      />
      <p id={helperId} className={invalid ? 'helper-text helper-text--error' : 'helper-text'}>
        {invalid
          ? t('rightPanel.quickConfig.subworkflowVersionInvalid')
          : draft.trim()
            ? t('rightPanel.quickConfig.subworkflowVersionPinnedHelper', { version: draft.trim() })
            : t('rightPanel.quickConfig.subworkflowVersionLatestHelper')}
      </p>
    </div>
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
  const replaceKeys = (keys: string[], next: Record<string, unknown>) => {
    const updated: Record<string, unknown> = { ...config }
    for (const key of keys) delete updated[key]
    onUpdate({ ...updated, ...next })
  }

  if (type === 'http') {
    return <HttpConfigEditor nodeId={nodeId} config={config} onUpdate={onUpdate} />
  }

  if (type === 'ai') {
    return <AiConfigEditor nodeId={nodeId} config={config} onUpdate={onUpdate} />
  }

  if (type === 'tool') {
    return <ToolConfigEditor nodeId={nodeId} config={config} tools={tools} onUpdate={onUpdate} />
  }

  if (type === 'agent' || type === 'multi_agent') {
    const plannerId = fieldId(nodeId, `${type} planner`)
    const teamModeId = fieldId(nodeId, 'team mode')
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextareaConfigField scope={nodeId} label={type === 'multi_agent' ? (t('rightPanel.quickConfig.teamGoal')) : (t('rightPanel.quickConfig.agentGoal'))} value={readConfigString(config, 'goal')} onChange={value => patch({ goal: value })} />
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
        {type === 'agent' && <TextConfigField scope={nodeId} label={t('rightPanel.quickConfig.inputValue')} value={readConfigString(config, 'value')} onChange={value => patch({ value })} />}
        <NumberConfigField scope={nodeId} label={t('rightPanel.quickConfig.maxSteps')} value={readConfigNumber(config, 'maxSteps') ?? 3} onChange={value => patch({ maxSteps: value })} />
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
    return <ApprovalConfigEditor nodeId={nodeId} config={config} onUpdate={onUpdate} />
  }

  if (type === 'human_form') {
    return <HumanFormConfigEditor nodeId={nodeId} config={config} onUpdate={onUpdate} />
  }

  if (type === 'condition') {
    return (
      <BranchRuleEditor
        id={`${nodeId}-branch-rule`}
        label={t('rightPanel.quickConfig.branchExpression')}
        value={readConfigString(config, 'expression')}
        onChange={value => patch({ expression: value })}
        nodes={workflowNodes}
        edges={workflowEdges}
        targetNodeId={nodeId}
        mode="node"
        workflowInputs={workflowInputs}
      />
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
            placeholder={t('rightPanel.quickConfig.pickWorkflow')}
            autoComplete="off"
            aria-describedby={workflowHelperId}
            aria-invalid={isSelfReference || undefined}
            aria-errormessage={isSelfReference ? workflowHelperId : undefined}
            onChange={event => replaceKeys(['workflowId', 'version'], { workflowId: event.target.value })}
          />
          <datalist id={workflowListId}>
            {choices.map(workflow => (
              <option
                key={workflow.id}
                value={workflow.id}
                label={t('rightPanel.quickConfig.workflowOption', { name: workflow.name, id: workflow.id })}
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
        <SubworkflowVersionField
          nodeId={nodeId}
          value={config.version}
          onChange={version => {
            if (version === undefined) replaceKeys(['version'], {})
            else patch({ version })
          }}
        />
        <JsonConfigField scope={nodeId} label={t('rightPanel.quickConfig.overrideInput')} value={asJsonObject(config.input)} onChange={value => patch({ input: value })} />
      </section>
    )
  }

  if (type === 'wait_until') {
    return <WaitUntilConfigEditor nodeId={nodeId} config={config} onUpdate={onUpdate} />
  }

  if (type === 'loop') {
    const mode = config.mode === 'for_each' ? 'for_each' : 'map'
    const modeId = fieldId(nodeId, 'loop mode')
    const failureBudgetMode = typeof config.toleratedFailurePercentage === 'number' ? 'percentage' : 'count'
    const failureBudgetModeId = fieldId(nodeId, 'loop failure budget mode')
    const selectedTool = readConfigString(config, 'tool')
    const selectedToolSchema = tools.find(tool => tool.name === selectedTool)
    return (
      <section className="quick-config" data-testid="loop-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <div className="config-field-row">
          <label className="field-label" htmlFor={modeId}>{t('rightPanel.quickConfig.loopMode')}</label>
          <select
            id={modeId}
            className="text-field"
            value={mode}
            onChange={event => {
              if (event.target.value === 'for_each') {
                patch({
                  mode: 'for_each',
                  tool: readConfigString(config, 'tool') || 'text.uppercase',
                  input: config.input ?? { value: '{{item}}' },
                  concurrency: readConfigNumber(config, 'concurrency') ?? LOOP_DEFAULT_CONCURRENCY,
                  ...(readConfigNumber(config, 'toleratedFailureCount') === null
                    && readConfigNumber(config, 'toleratedFailurePercentage') === null
                    ? { toleratedFailureCount: 0 }
                    : {}),
                })
              } else {
                patch({
                  mode: 'map',
                  mapping: config.mapping ?? { value: '{{item}}', index: '{{index}}' },
                })
              }
            }}
          >
            <option value="map">{t('rightPanel.quickConfig.loopModeMap')}</option>
            <option value="for_each">{t('rightPanel.quickConfig.loopModeForEach')}</option>
          </select>
        </div>
        <TextConfigField scope={nodeId} label={t('rightPanel.quickConfig.items')} value={readConfigString(config, 'items')} onChange={value => patch({ items: value })} />
        {mode === 'map' ? (
          <JsonConfigField scope={nodeId} label={t('rightPanel.quickConfig.itemMapping')} value={asJsonObject(config.mapping)} onChange={value => patch({ mapping: value })} />
        ) : (
          <div data-testid="loop-for-each-config">
            <ToolPicker
              nodeId={`${nodeId}-loop`}
              selectedTool={selectedTool}
              tools={tools}
              onChange={(tool, input) => patch({ tool, input })}
            />
            <ToolInputEditor
              scope={`${nodeId}-loop`}
              tool={selectedToolSchema}
              input={config.input}
              rawLabel={t('rightPanel.quickConfig.loopToolInput')}
              onChange={input => patch({ input })}
            />
            <OptionalNumberConfigField
              scope={nodeId}
              label={t('rightPanel.quickConfig.loopConcurrency')}
              value={readConfigNumber(config, 'concurrency')}
              min={1}
              max={LOOP_MAX_CONCURRENCY}
              placeholder={String(LOOP_DEFAULT_CONCURRENCY)}
              onChange={value => patch({ concurrency: value ?? LOOP_DEFAULT_CONCURRENCY })}
            />
            <div className="config-field-row">
              <label className="field-label" htmlFor={failureBudgetModeId}>{t('rightPanel.quickConfig.loopFailureBudget')}</label>
              <select
                id={failureBudgetModeId}
                className="text-field"
                value={failureBudgetMode}
                onChange={event => {
                  if (event.target.value === 'percentage') {
                    replaceKeys(['toleratedFailureCount', 'toleratedFailurePercentage'], { toleratedFailurePercentage: 0 })
                  } else {
                    replaceKeys(['toleratedFailureCount', 'toleratedFailurePercentage'], { toleratedFailureCount: 0 })
                  }
                }}
              >
                <option value="count">{t('rightPanel.quickConfig.loopFailureBudgetCount')}</option>
                <option value="percentage">{t('rightPanel.quickConfig.loopFailureBudgetPercentage')}</option>
              </select>
            </div>
            {failureBudgetMode === 'percentage' ? (
              <OptionalNumberConfigField
                scope={nodeId}
                label={t('rightPanel.quickConfig.loopFailurePercentage')}
                value={readConfigNumber(config, 'toleratedFailurePercentage')}
                min={0}
                max={100}
                step="any"
                placeholder="0"
                onChange={value => patch({ toleratedFailurePercentage: value ?? 0 })}
              />
            ) : (
              <OptionalNumberConfigField
                scope={nodeId}
                label={t('rightPanel.quickConfig.loopFailureCount')}
                value={readConfigNumber(config, 'toleratedFailureCount')}
                min={0}
                max={1000}
                placeholder="0"
                onChange={value => patch({ toleratedFailureCount: value ?? 0 })}
              />
            )}
            <p className="helper-text" data-testid="loop-for-each-helper">
              <Trans i18nKey="rightPanel.quickConfig.loopForEachHelper" components={{ code: <code /> }} />
            </p>
          </div>
        )}
      </section>
    )
  }

  if (type === 'transform') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <JsonConfigField scope={nodeId} label={t('rightPanel.quickConfig.fieldMapping')} value={asJsonObject(config.mapping)} onChange={value => patch({ mapping: value })} />
      </section>
    )
  }

  if (type === 'router' || type === 'router_llm') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <JsonConfigField scope={nodeId} label={t('rightPanel.quickConfig.candidates')} value={Array.isArray(config.candidates) ? config.candidates : []} onChange={value => patch({ candidates: value })} />
      </section>
    )
  }

  if (type === 'parallel_fork') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <JsonConfigField
          scope={nodeId}
          label={t('rightPanel.quickConfig.branches')}
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
          label={t('rightPanel.quickConfig.branchSources')}
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
    return <ScheduleConfigEditor nodeId={nodeId} config={config} onUpdate={onUpdate} />
  }

  if (type === 'webhook_received') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField
          scope={nodeId}
          label={t('rightPanel.quickConfig.webhookEndpointKey')}
          value={readConfigString(config, 'endpointKey')}
          onChange={value => patch({ endpointKey: value })}
        />
        <p className="helper-text">{t('rightPanel.quickConfig.webhookReceivedHelper')}</p>
      </section>
    )
  }

  if (type === 'email_received') {
    const dkimRequired = config.dkimRequired !== false
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField
          scope={nodeId}
          label={t('rightPanel.quickConfig.emailAliasKey')}
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
          label={t('rightPanel.quickConfig.fileBucket')}
          value={readConfigString(config, 'bucket')}
          onChange={value => patch({ bucket: value })}
        />
        <TextConfigField
          scope={nodeId}
          label={t('rightPanel.quickConfig.filePrefix')}
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
          label={t('rightPanel.quickConfig.mcpEventConnectionAlias')}
          value={readConfigString(config, 'connectionAlias')}
          onChange={value => patch({ connectionAlias: value })}
        />
        <TextConfigField
          scope={nodeId}
          label={t('rightPanel.quickConfig.mcpEventResourceUri')}
          value={readConfigString(config, 'resourceUri')}
          onChange={value => patch({ resourceUri: value })}
        />
        <p className="helper-text">{t('rightPanel.quickConfig.mcpServerEventHelper')}</p>
      </section>
    )
  }

  if (type === 'pagerduty_incident') {
    const callbackUrl = currentWorkflowId
      ? publicApiUrl(`/webhooks/pagerduty/${encodeURIComponent(currentWorkflowId)}/${encodeURIComponent(nodeId)}`)
      : ''
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField
          scope={nodeId}
          label={t('rightPanel.quickConfig.pagerdutyWebhookCredential')}
          value={readConfigString(config, 'webhookCredential')}
          onChange={value => patch({ webhookCredential: value })}
        />
        <OptionalNumberConfigField
          scope={nodeId}
          label={t('rightPanel.quickConfig.pagerdutyRateLimit')}
          value={readConfigNumber(config, 'rateLimitPerMin')}
          min={1}
          max={10_000}
          onChange={value => patch({ rateLimitPerMin: value })}
        />
        <label className="field-label" htmlFor={fieldId(nodeId, 'PagerDuty callback')}>
          {t('rightPanel.quickConfig.pagerdutyCallback')}
        </label>
        <input
          id={fieldId(nodeId, 'PagerDuty callback')}
          className="text-field mono"
          readOnly
          value={callbackUrl}
          placeholder={t('rightPanel.quickConfig.pagerdutyCallbackUnavailable')}
        />
        <p className="helper-text">{t('rightPanel.quickConfig.pagerdutyIncidentHelper')}</p>
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
