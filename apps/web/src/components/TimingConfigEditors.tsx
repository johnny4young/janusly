import { useCallback, useEffect, useState } from 'react'

import { Trans, useT } from '../i18n'
import type { JsonObject } from '../types'
import {
  asJsonObject,
  fieldId,
  JsonConfigField,
  readConfigNumber,
  readConfigString,
  TextareaConfigField,
  TextConfigField,
} from './quick-config-fields'
import { ScheduleCronPreview } from './ScheduleCronPreview'
import type { ScheduleCronPreviewSnapshot } from './ScheduleCronPreview'

type ConfigEditorProps = {
  nodeId: string
  config: JsonObject
  onUpdate: (config: Record<string, unknown>) => void
}

function configActions(config: JsonObject, onUpdate: ConfigEditorProps['onUpdate']) {
  return {
    patch(next: Record<string, unknown>) {
      onUpdate({ ...config, ...next })
    },
    replaceKeys(keys: string[], next: Record<string, unknown>) {
      const updated: Record<string, unknown> = { ...config }
      for (const key of keys) delete updated[key]
      onUpdate({ ...updated, ...next })
    },
  }
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

export function ApprovalConfigEditor({ nodeId, config, onUpdate }: ConfigEditorProps) {
  const { t } = useT()
  const { patch, replaceKeys } = configActions(config, onUpdate)
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

export function HumanFormConfigEditor({ nodeId, config, onUpdate }: ConfigEditorProps) {
  const { t } = useT()
  const { patch } = configActions(config, onUpdate)
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

export function WaitUntilConfigEditor({ nodeId, config, onUpdate }: ConfigEditorProps) {
  const { t } = useT()
  const { patch, replaceKeys } = configActions(config, onUpdate)
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

export function ScheduleConfigEditor({ nodeId, config, onUpdate }: ConfigEditorProps) {
  const { t } = useT()
  const { patch } = configActions(config, onUpdate)
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
          onChange={event => patch({ cronExpression: event.target.value })}
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
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={event => patch({ enabled: event.target.checked })}
        />
        <span>{t('rightPanel.quickConfig.scheduleEnabled')}</span>
      </label>
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
