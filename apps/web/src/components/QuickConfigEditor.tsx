/**
 * Per-node-type config editor mounted inside the Inspector. A type-switch
 * with a branch per supported `nodeType`, dispatching to small per-branch
 * sub-forms. The `mcp_tool` branch delegates to `McpToolConfigField` for
 * the async connection / tool dropdown pair.
 *
 * Used by:
 * - `InspectorPanel.tsx` (rendered inside the per-node card).
 */

import { useCallback, useEffect, useState } from 'react'
import { publicApiUrl } from '../api'
import type { JsonObject, SavedWorkflow, ToolSchema, WorkflowGraphEdge, WorkflowGraphNode, WorkflowInputSchemaShape } from '../types'
import { Trans, tToolDescription, useT } from '../i18n'
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
  OptionalNumberConfigField,
  readConfigNumber,
  readConfigString,
  TextareaConfigField,
  TextConfigField,
} from './quick-config-fields'

// Mirrors `@janusly/shared.workflowVersionMax` without importing the runtime
// barrel into this lazy authoring chunk and perturbing the production split.
const SUBWORKFLOW_VERSION_MAX = 2_147_483_647
const LOOP_DEFAULT_CONCURRENCY = 4
const LOOP_MAX_CONCURRENCY = 20

function isPositiveVersion(value: string): boolean {
  if (!/^\d+$/.test(value)) return false
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= SUBWORKFLOW_VERSION_MAX
}

function ToolPicker({ nodeId, selectedTool, input, tools, onChange }: {
  nodeId: string
  selectedTool: string
  input: unknown
  tools: ToolSchema[]
  onChange: (tool: string, input: unknown) => void
}) {
  const { t } = useT()
  const matchedTool = tools.find(tool => tool.name === selectedTool) ?? null
  const showCurrentToolOption = Boolean(selectedTool) && !matchedTool
  const isUnknown = showCurrentToolOption && tools.length > 0
  const toolNameId = fieldId(nodeId, 'tool name')
  const onSelectTool = (next: string) => {
    const inputIsEmpty = !input || (typeof input === 'object' && input !== null && !Array.isArray(input) && Object.keys(input).length === 0)
    const newTool = tools.find(tool => tool.name === next)
    const seedInput = inputIsEmpty && newTool?.inputExample ? newTool.inputExample : input
    onChange(next, seedInput)
  }
  return (
    <div className="form-grid" data-testid="tool-picker">
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
      {matchedTool?.description && <p className="helper-text">{tToolDescription(matchedTool)}</p>}
      {matchedTool?.required && matchedTool.required.length > 0 && (
        <p className="helper-text">{t('rightPanel.quickConfig.requiredInput', { required: matchedTool.required.join(', ') })}{matchedTool.optional?.length ? t('rightPanel.quickConfig.optionalSuffix', { optional: matchedTool.optional.join(', ') }) : ''}</p>
      )}
      {isUnknown && <p className="helper-text" data-testid="unknown-tool-warning">{t('rightPanel.quickConfig.unknownToolWarning')}</p>}
    </div>
  )
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

function ApprovalTimeoutField({ nodeId, valueMs, describedBy, onChange }: {
  nodeId: string
  valueMs: number
  describedBy: string
  onChange: (valueMs: number) => void
}) {
  const { t } = useT()
  const id = fieldId(nodeId, 'approval timeout seconds')
  const seconds = valueMs / 1_000
  const [draft, setDraft] = useState(String(seconds))

  useEffect(() => setDraft(String(seconds)), [nodeId, seconds])

  return (
    <div className="config-field-row">
      <label className="field-label" htmlFor={id}>{t('rightPanel.quickConfig.approvalTimeoutSeconds')}</label>
      <input
        id={id}
        className="text-field"
        type="number"
        min="0.001"
        step="0.001"
        value={draft}
        aria-describedby={describedBy}
        onChange={event => setDraft(event.target.value)}
        onBlur={() => {
          const parsedSeconds = Number(draft)
          const nextMs = Math.round(parsedSeconds * 1_000)
          if (!Number.isFinite(parsedSeconds) || parsedSeconds <= 0 || !Number.isSafeInteger(nextMs) || nextMs <= 0) {
            setDraft(String(seconds))
            return
          }
          setDraft(String(nextMs / 1_000))
          if (nextMs !== valueMs) onChange(nextMs)
        }}
      />
    </div>
  )
}

function AbsoluteDateTimeField({ nodeId, field, label, helper, value, onChange }: {
  nodeId: string
  field: string
  label: string
  helper: string
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useT()
  const id = fieldId(nodeId, field)
  const helperId = `${id}-helper`
  const errorId = `${id}-error`
  const renderedValue = isoToLocalDateTime(value)
  const [draft, setDraft] = useState(renderedValue)
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    setDraft(renderedValue)
    setInvalid(false)
  }, [nodeId, renderedValue])

  return (
    <div className="config-field-row">
      <label className="field-label" htmlFor={id}>{label}</label>
      <input
        id={id}
        className="text-field"
        type="datetime-local"
        step="0.001"
        value={draft}
        aria-describedby={helperId}
        aria-invalid={invalid || undefined}
        aria-errormessage={invalid ? errorId : undefined}
        onChange={event => setDraft(event.target.value)}
        onBlur={() => {
          if (normalizeLocalDateTime(draft) === renderedValue) {
            setDraft(renderedValue)
            setInvalid(false)
            return
          }
          const iso = localDateTimeToIso(draft)
          if (!iso) {
            setInvalid(true)
            return
          }
          setInvalid(false)
          onChange(iso)
        }}
      />
      <p id={helperId} className="helper-text">{t(helper, { timezone: operatorTimeZone() })}</p>
      {invalid && <p id={errorId} className="helper-text helper-text--error" role="alert">{t('rightPanel.quickConfig.invalidLocalDateTime')}</p>}
    </div>
  )
}

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
  const replaceKeys = (keys: string[], next: Record<string, unknown>) => {
    const updated: Record<string, unknown> = { ...config }
    for (const key of keys) delete updated[key]
    onUpdate({ ...updated, ...next })
  }

  if (type === 'http') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField scope={nodeId} label={t('rightPanel.quickConfig.requestUrl')} value={readConfigString(config, 'url')} onChange={value => patch({ url: value })} />
        <p className="helper-text" data-testid="http-json-contract-helper">
          <Trans i18nKey="rightPanel.quickConfig.httpJsonHelper" components={{ code: <code /> }} />
        </p>
        <ResilienceFieldset nodeId={nodeId} nodeType="http" config={config} onPatch={patch} />
      </section>
    )
  }

  if (type === 'ai') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextareaConfigField scope={nodeId} label={t('rightPanel.quickConfig.prompt')} value={readConfigString(config, 'prompt')} onChange={value => patch({ prompt: value })} />
      </section>
    )
  }

  if (type === 'tool') {
    const selectedTool = readConfigString(config, 'tool')
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <ToolPicker
          nodeId={nodeId}
          selectedTool={selectedTool}
          input={config.input}
          tools={tools}
          onChange={(tool, input) => patch({ tool, input })}
        />
        <JsonConfigField scope={nodeId} label={t('rightPanel.quickConfig.toolInput')} value={asJsonObject(config.input)} onChange={value => patch({ input: value })} />
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
    const decisionTimeoutMs = readConfigNumber(config, 'decisionTimeoutMs')
    const until = readConfigString(config, 'until')
    const deadlineMode = until ? 'until' : decisionTimeoutMs !== null ? 'timeout' : 'none'
    const onTimeout = readConfigString(config, 'onTimeout') || 'fail'
    const deadlineModeId = fieldId(nodeId, 'approval deadline mode')
    const timeoutPolicyId = fieldId(nodeId, 'approval timeout policy')
    const assigneeHelperId = `${fieldId(nodeId, t('rightPanel.quickConfig.approvalAssignee'))}-helper`
    const deadlineHelperId = `${deadlineModeId}-helper`
    return (
      <section className="quick-config" data-testid="approval-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextareaConfigField scope={nodeId} label={t('rightPanel.quickConfig.approvalMessage')} value={readConfigString(config, 'message')} onChange={value => patch({ message: value })} />
        <TextConfigField scope={nodeId} label={t('rightPanel.quickConfig.approvalAssignee')} value={readConfigString(config, 'assignee')} describedBy={assigneeHelperId} onChange={value => patch({ assignee: value })} />
        <p id={assigneeHelperId} className="helper-text">{t('rightPanel.quickConfig.approvalAssigneeHelper')}</p>
        <div className="config-field-row">
          <label className="field-label" htmlFor={deadlineModeId}>{t('rightPanel.quickConfig.approvalDeadlineMode')}</label>
          <select
            id={deadlineModeId}
            className="text-field"
            value={deadlineMode}
            aria-describedby={deadlineMode === 'none' ? undefined : deadlineHelperId}
            onChange={(event) => {
              if (event.target.value === 'none') {
                replaceKeys(['decisionTimeoutMs', 'until', 'onTimeout', 'escalateTo'], {})
              } else if (event.target.value === 'timeout') {
                replaceKeys(['decisionTimeoutMs', 'until'], { decisionTimeoutMs: decisionTimeoutMs ?? 5 * 60_000, onTimeout })
              } else {
                replaceKeys(['decisionTimeoutMs', 'until'], {
                  until: until || new Date(Date.now() + 60 * 60_000).toISOString(),
                  onTimeout,
                })
              }
            }}
          >
            <option value="none">{t('rightPanel.quickConfig.approvalDeadlineNone')}</option>
            <option value="timeout">{t('rightPanel.quickConfig.approvalDeadlineAfter')}</option>
            <option value="until">{t('rightPanel.quickConfig.approvalDeadlineAt')}</option>
          </select>
        </div>
        {deadlineMode === 'timeout' && (
          <ApprovalTimeoutField
            nodeId={nodeId}
            valueMs={decisionTimeoutMs ?? 5 * 60_000}
            describedBy={deadlineHelperId}
            onChange={value => patch({ decisionTimeoutMs: value })}
          />
        )}
        {deadlineMode === 'until' && (
          <AbsoluteDateTimeField
            nodeId={nodeId}
            field="approval deadline"
            label={t('rightPanel.quickConfig.approvalDeadline')}
            helper="rightPanel.quickConfig.absoluteDateTimeHelper"
            value={until}
            onChange={value => patch({ until: value })}
          />
        )}
        {deadlineMode !== 'none' && (
          <>
            <div className="config-field-row">
              <label className="field-label" htmlFor={timeoutPolicyId}>{t('rightPanel.quickConfig.approvalTimeoutPolicy')}</label>
              <select
                id={timeoutPolicyId}
                className="text-field"
                value={onTimeout}
                aria-describedby={deadlineHelperId}
                onChange={(event) => {
                  const next = event.target.value
                  if (next === 'escalate') patch({ onTimeout: next })
                  else replaceKeys(['onTimeout', 'escalateTo'], { onTimeout: next })
                }}
              >
                <option value="fail">{t('rightPanel.quickConfig.approvalTimeoutFail')}</option>
                <option value="auto_reject">{t('rightPanel.quickConfig.approvalTimeoutReject')}</option>
                <option value="escalate">{t('rightPanel.quickConfig.approvalTimeoutEscalate')}</option>
              </select>
            </div>
            {onTimeout === 'escalate' && (
              <TextConfigField scope={nodeId} label={t('rightPanel.quickConfig.approvalEscalateTo')} value={readConfigString(config, 'escalateTo')} describedBy={deadlineHelperId} onChange={value => patch({ escalateTo: value })} />
            )}
            <p id={deadlineHelperId} className="helper-text">{t('rightPanel.quickConfig.approvalDeadlineHelper')}</p>
          </>
        )}
      </section>
    )
  }

  if (type === 'human_form') {
    return (
      <section className="quick-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <TextConfigField scope={nodeId} label={t('rightPanel.quickConfig.formTitle')} value={readConfigString(config, 'title')} onChange={value => patch({ title: value })} />
        <TextareaConfigField scope={nodeId} label={t('rightPanel.quickConfig.formInstructions')} value={readConfigString(config, 'description')} onChange={value => patch({ description: value })} />
        <JsonConfigField scope={nodeId} label={t('rightPanel.quickConfig.fieldsSchema')} value={asJsonObject(config.schema)} onChange={value => patch({ schema: value })} />
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
          label={t('rightPanel.quickConfig.branchExpression')}
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
    const until = readConfigString(config, 'until')
    const mode = until ? 'until' : 'duration'
    const modeId = fieldId(nodeId, 'wait mode')
    const durationHelperId = `${fieldId(nodeId, t('rightPanel.quickConfig.duration'))}-helper`
    return (
      <section className="quick-config" data-testid="wait-until-config">
        <div className="section-kicker">{t('rightPanel.quickConfig.kicker')}</div>
        <div className="config-field-row">
          <label className="field-label" htmlFor={modeId}>{t('rightPanel.quickConfig.waitMode')}</label>
          <select
            id={modeId}
            className="text-field"
            value={mode}
            onChange={(event) => {
              if (event.target.value === 'until') {
                replaceKeys(['duration', 'until'], { until: new Date(Date.now() + 60 * 60_000).toISOString() })
              } else {
                replaceKeys(['duration', 'until'], { duration: 'PT5M' })
              }
            }}
          >
            <option value="duration">{t('rightPanel.quickConfig.waitForDuration')}</option>
            <option value="until">{t('rightPanel.quickConfig.waitUntilDate')}</option>
          </select>
        </div>
        {mode === 'duration' ? (
          <>
            <TextConfigField scope={nodeId} label={t('rightPanel.quickConfig.duration')} value={readConfigString(config, 'duration')} describedBy={durationHelperId} onChange={value => patch({ duration: value })} />
            <p id={durationHelperId} className="helper-text">
              <Trans i18nKey="rightPanel.quickConfig.durationHelper" components={{ code: <code /> }} />
            </p>
          </>
        ) : (
          <AbsoluteDateTimeField
            nodeId={nodeId}
            field="wait until"
            label={t('rightPanel.quickConfig.waitUntil')}
            helper="rightPanel.quickConfig.waitUntilHelper"
            value={until}
            onChange={value => patch({ until: value })}
          />
        )}
      </section>
    )
  }

  if (type === 'loop') {
    const mode = config.mode === 'for_each' ? 'for_each' : 'map'
    const modeId = fieldId(nodeId, 'loop mode')
    const failureBudgetMode = typeof config.toleratedFailurePercentage === 'number' ? 'percentage' : 'count'
    const failureBudgetModeId = fieldId(nodeId, 'loop failure budget mode')
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
              selectedTool={readConfigString(config, 'tool')}
              input={config.input}
              tools={tools}
              onChange={(tool, input) => patch({ tool, input })}
            />
            <JsonConfigField scope={nodeId} label={t('rightPanel.quickConfig.loopToolInput')} value={asJsonObject(config.input)} onChange={value => patch({ input: value })} />
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
    return <ScheduleConfigFields nodeId={nodeId} config={config} onPatch={patch} />
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

function isoToLocalDateTime(value: string): string {
  if (!value) return ''
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  const localTimestamp = timestamp - new Date(timestamp).getTimezoneOffset() * 60_000
  return new Date(localTimestamp).toISOString().slice(0, 23)
}

function localDateTimeToIso(value: string): string | null {
  if (!value) return null
  const normalized = normalizeLocalDateTime(value)
  const timestamp = Date.parse(normalized)
  if (!Number.isFinite(timestamp)) return null
  const localAsUtc = Date.parse(`${normalized}Z`)
  if (!Number.isFinite(localAsUtc)) return null

  const offsets = new Set([
    new Date(timestamp - 86_400_000).getTimezoneOffset(),
    new Date(timestamp).getTimezoneOffset(),
    new Date(timestamp + 86_400_000).getTimezoneOffset(),
  ])
  const candidates = [...offsets]
    .map(offset => localAsUtc + offset * 60_000)
    .filter(candidate => isoToLocalDateTime(new Date(candidate).toISOString()) === normalized)
  return candidates.length === 1 ? new Date(candidates[0]).toISOString() : null
}

function normalizeLocalDateTime(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return `${value}:00.000`
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) return `${value}.000`
  const fractional = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{1,3})$/.exec(value)
  return fractional ? `${fractional[1]}.${fractional[2].padEnd(3, '0')}` : value
}

function operatorTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}
