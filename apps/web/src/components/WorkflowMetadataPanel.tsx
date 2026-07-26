/**
 * Edit form for per-workflow operational metadata. Mounted inside the
 * Inspector right panel next to `WorkflowSloPanel`. Saves via
 * `POST /workflows/:id/metadata` and bumps the platform-version tick on
 * success so `WorkflowAboutCard` (in the Recovery dialog) refetches
 * without a reload.
 *
 * The server enforces `permission: workflows.write` (editor + admin
 * default). Non-editors see the form mounted but the save returns the
 * existing 403 toast envelope. Form fields use the shared closed-enum
 * + size caps from the server contract; client-side counters surface size
 * limits as the operator types.
 */

import { useEffect, useRef, useState } from 'react'

import {
  RECOVERY_ITEM_SEVERITIES,
  type RecoveryItemSeverity,
} from '@janusly/shared/src/recovery-item'
import {
  WorkflowMetadataSchema,
  WORKFLOW_METADATA_AI_GUIDANCE_MAX_BYTES,
  WORKFLOW_METADATA_RUNBOOK_MAX_BYTES,
} from '@janusly/shared/src/workflow-metadata'
import { containsOperatorGuidanceSecret } from '@janusly/shared/src/operator-guidance'
import { api } from '../api'
import { getResolvedLocale, tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'

type WorkflowMetadataForm = {
  owners: string[]
  runbookMarkdown: string
  aiGuidanceMarkdown: string
  description: string
  tags: string[]
  folder: string
  slackChannel: string
  linearProject: string
  severityDefault: RecoveryItemSeverity | ''
}

const EMPTY_FORM: WorkflowMetadataForm = {
  owners: [],
  runbookMarkdown: '',
  aiGuidanceMarkdown: '',
  description: '',
  tags: [],
  folder: '',
  slackChannel: '',
  linearProject: '',
  severityDefault: '',
}

const WORKFLOW_METADATA_FOLDER_MAX_LENGTH = 60
type WorkflowMetadataLoadState = 'idle' | 'loading' | 'ready' | 'error'

type ParsedWorkflowMetadata =
  | { ok: true; form: WorkflowMetadataForm }
  | { ok: false }

function freshEmptyForm(): WorkflowMetadataForm {
  return { ...EMPTY_FORM, owners: [], tags: [] }
}

/** Runtime boundary for the legacy, non-v1 metadata envelope. */
function parseWorkflowMetadataPayload(payload: unknown): ParsedWorkflowMetadata {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false }
  const envelope = payload as Record<string, unknown>
  if (!Object.hasOwn(envelope, 'metadata')) return { ok: false }
  if (envelope.metadata === null) return { ok: true, form: freshEmptyForm() }
  if (typeof envelope.metadata !== 'object' || Array.isArray(envelope.metadata)) {
    return { ok: false }
  }
  const record = envelope.metadata as Record<string, unknown>
  const parsed = WorkflowMetadataSchema.safeParse({
    owners: record.owners,
    runbookMarkdown: record.runbookMarkdown,
    aiGuidanceMarkdown: record.aiGuidanceMarkdown,
    description: record.description,
    tags: record.tags,
    folder: record.folder,
    slackChannel: record.slackChannel,
    linearProject: record.linearProject,
    severityDefault: record.severityDefault,
  })
  if (!parsed.success) return { ok: false }
  const metadata = parsed.data
  return {
    ok: true,
    form: {
      owners: metadata.owners,
      runbookMarkdown: metadata.runbookMarkdown ?? '',
      aiGuidanceMarkdown: metadata.aiGuidanceMarkdown ?? '',
      description: metadata.description ?? '',
      tags: metadata.tags,
      folder: metadata.folder ?? '',
      slackChannel: metadata.slackChannel ?? '',
      linearProject: metadata.linearProject ?? '',
      severityDefault: metadata.severityDefault ?? '',
    },
  }
}

function parseChipList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

export type WorkflowMetadataPanelProps = {
  workflowId?: string | undefined
  readOnly?: boolean
}

export function WorkflowMetadataPanel({ workflowId: explicit, readOnly = false }: WorkflowMetadataPanelProps = {}) {
  const { t } = useT()
  const addToast = useWorkflowStore((s) => s.addToast)
  const bumpPlatformVersion = useWorkflowStore((s) => s.bumpPlatformVersion)
  const platformVersion = useWorkflowStore((s) => s.platformVersion)
  const storeWorkflowId = useWorkflowStore((s) => s.currentWorkflowId)
  const storeWorkflowSaved = useWorkflowStore((s) => s.currentWorkflowSaved)
  // With no explicit id this panel targets the current draft — but only once
  // it has been saved. An unsaved draft has no server row, so fetching its
  // metadata would 404; an explicit id (e.g. the recovery drawer) always resolves.
  const workflowId = explicit ?? (storeWorkflowSaved ? storeWorkflowId : undefined)

  const [form, setForm] = useState<WorkflowMetadataForm>(() => freshEmptyForm())
  const [ownersRaw, setOwnersRaw] = useState('')
  const [tagsRaw, setTagsRaw] = useState('')
  const [loadState, setLoadState] = useState<WorkflowMetadataLoadState>('idle')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [saving, setSaving] = useState(false)
  const activeWorkflowRef = useRef<string | null>(null)
  const readyWorkflowRef = useRef<string | null>(null)
  const dirtyRef = useRef(false)
  const requestEpochRef = useRef(0)

  useEffect(() => {
    if (!workflowId) {
      activeWorkflowRef.current = null
      readyWorkflowRef.current = null
      dirtyRef.current = false
      requestEpochRef.current += 1
      setForm(freshEmptyForm())
      setOwnersRaw('')
      setTagsRaw('')
      setLoadState('idle')
      setLoadError(null)
      return
    }
    let cancelled = false
    const controller = new AbortController()
    const epoch = requestEpochRef.current + 1
    requestEpochRef.current = epoch
    const workflowChanged = activeWorkflowRef.current !== workflowId
    if (workflowChanged) {
      activeWorkflowRef.current = workflowId
      readyWorkflowRef.current = null
      dirtyRef.current = false
      setForm(freshEmptyForm())
      setOwnersRaw('')
      setTagsRaw('')
    }
    if (readyWorkflowRef.current !== workflowId) {
      setLoadState('loading')
      setLoadError(null)
    }
    api(`/workflows/${encodeURIComponent(workflowId)}/metadata`, { signal: controller.signal })
      .then((payload) => {
        if (cancelled || requestEpochRef.current !== epoch) return
        const parsed = parseWorkflowMetadataPayload(payload)
        if (!parsed.ok) {
          if (readyWorkflowRef.current !== workflowId) setLoadState('error')
          setLoadError(t('workflowMetadata.panel.loadError'))
          return
        }
        if (!dirtyRef.current || readyWorkflowRef.current !== workflowId) {
          setForm(parsed.form)
          setOwnersRaw(parsed.form.owners.join(', '))
          setTagsRaw(parsed.form.tags.join(', '))
        }
        readyWorkflowRef.current = workflowId
        setLoadState('ready')
        setLoadError(null)
      })
      .catch((error) => {
        if (cancelled || requestEpochRef.current !== epoch) return
        if (readyWorkflowRef.current !== workflowId) setLoadState('error')
        setLoadError(tApiError(error) || t('workflowMetadata.panel.loadError'))
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [workflowId, platformVersion, reloadNonce, t])

  if (!workflowId) return null

  async function onSave(e: React.FormEvent) {
    e.preventDefault()
    if (
      !workflowId
      || saving
      || loadState !== 'ready'
      || runbookOverCap
      || aiGuidanceOverCap
      || aiGuidanceHasSecret
    ) return
    const targetWorkflowId = workflowId
    setSaving(true)
    try {
      const metadata = {
        owners: parseChipList(ownersRaw),
        runbookMarkdown: form.runbookMarkdown.trim().length > 0 ? form.runbookMarkdown : null,
        aiGuidanceMarkdown: form.aiGuidanceMarkdown.trim().length > 0 ? form.aiGuidanceMarkdown : null,
        description: form.description.trim().length > 0 ? form.description : null,
        tags: parseChipList(tagsRaw),
        folder: form.folder.trim().length > 0 ? form.folder.trim() : null,
        slackChannel: form.slackChannel.trim().length > 0 ? form.slackChannel.trim() : null,
        linearProject: form.linearProject.trim().length > 0 ? form.linearProject.trim() : null,
        severityDefault: form.severityDefault === '' ? null : form.severityDefault,
      }
      await api(`/workflows/${encodeURIComponent(workflowId)}/metadata`, {
        method: 'POST',
        body: JSON.stringify({ metadata }),
      })
      if (activeWorkflowRef.current === targetWorkflowId) {
        // A platform refresh may still be carrying the pre-save snapshot.
        // Invalidate it before marking the successful form as clean so that
        // its late response cannot replace the values the operator just saved.
        requestEpochRef.current += 1
        dirtyRef.current = false
      }
      addToast(t('workflowMetadata.toast.saved'), 'success')
      bumpPlatformVersion()
    } catch (err) {
      addToast(tApiError(err) || (t('workflowMetadata.toast.saveFailed')), 'error')
    } finally {
      setSaving(false)
    }
  }

  const runbookByteLength = new TextEncoder().encode(form.runbookMarkdown).length
  const runbookOverCap = runbookByteLength > WORKFLOW_METADATA_RUNBOOK_MAX_BYTES
  const aiGuidanceByteLength = new TextEncoder().encode(form.aiGuidanceMarkdown).length
  const aiGuidanceOverCap = aiGuidanceByteLength > WORKFLOW_METADATA_AI_GUIDANCE_MAX_BYTES
  const aiGuidanceHasSecret = containsOperatorGuidanceSecret(form.aiGuidanceMarkdown)
  const loading = loadState === 'loading'
  const editorDisabled = readOnly || loadState !== 'ready' || saving

  function updateForm<K extends keyof WorkflowMetadataForm>(key: K, value: WorkflowMetadataForm[K]) {
    dirtyRef.current = true
    setForm((current) => ({ ...current, [key]: value }))
  }

  return (
    <section className="we-card we-workflow-metadata-panel" aria-labelledby="we-workflow-metadata-title">
      <h3 id="we-workflow-metadata-title" className="section-title">
        {t('workflowMetadata.panel.title')}
      </h3>
      <p className="helper-text">{t('workflowMetadata.panel.description')}</p>
      {loadError && (
        <div data-testid="workflow-metadata-load-error">
          <p className="helper-text we-helper-text--error" role="alert">{loadError}</p>
          <button
            type="button"
            className="command-button"
            onClick={() => setReloadNonce((value) => value + 1)}
            disabled={saving || loading}
            data-testid="workflow-metadata-retry"
          >
            {t('workflowMetadata.action.retry')}
          </button>
        </div>
      )}
      <form className="we-workflow-metadata-panel__form" onSubmit={onSave}>
        <label className="we-field">
          <span>{t('workflowMetadata.field.owners')}</span>
          <input
            type="text"
            value={ownersRaw}
            onChange={(e) => {
              dirtyRef.current = true
              setOwnersRaw(e.target.value)
            }}
            placeholder={t('workflowMetadata.field.ownersPlaceholder')}
            disabled={editorDisabled}
            data-testid="workflow-metadata-owners"
          />
          <span className="helper-text">{t('workflowMetadata.field.ownersHelp')}</span>
        </label>

        <label className="we-field">
          <span>{t('workflowMetadata.field.description')}</span>
          <input
            type="text"
            value={form.description}
            maxLength={2000}
            onChange={(e) => updateForm('description', e.target.value)}
            disabled={editorDisabled}
          />
        </label>

        <label className="we-field">
          <span>{t('workflowMetadata.field.tags')}</span>
          <input
            type="text"
            value={tagsRaw}
            onChange={(e) => {
              dirtyRef.current = true
              setTagsRaw(e.target.value)
            }}
            placeholder={t('workflowMetadata.field.tagsPlaceholder')}
            disabled={editorDisabled}
          />
        </label>

        <label className="we-field">
          <span>{t('workflowMetadata.field.folder')}</span>
          <input
            type="text"
            value={form.folder}
            maxLength={WORKFLOW_METADATA_FOLDER_MAX_LENGTH}
            onChange={(e) => updateForm('folder', e.target.value)}
            placeholder={t('workflowMetadata.field.folderPlaceholder')}
            disabled={editorDisabled}
            data-testid="workflow-metadata-folder"
          />
        </label>

        <label className="we-field">
          <span>{t('workflowMetadata.field.slackChannel')}</span>
          <input
            type="text"
            value={form.slackChannel}
            maxLength={80}
            onChange={(e) => updateForm('slackChannel', e.target.value)}
            placeholder={t('workflowMetadata.field.slackChannelPlaceholder')}
            disabled={editorDisabled}
          />
        </label>

        <label className="we-field">
          <span>{t('workflowMetadata.field.linearProject')}</span>
          <input
            type="text"
            value={form.linearProject}
            maxLength={200}
            onChange={(e) => updateForm('linearProject', e.target.value)}
            placeholder={t('workflowMetadata.field.linearProjectPlaceholder')}
            disabled={editorDisabled}
          />
        </label>

        <label className="we-field">
          <span>{t('workflowMetadata.field.severityDefault')}</span>
          <select
            value={form.severityDefault}
            onChange={(e) => updateForm('severityDefault', e.target.value as RecoveryItemSeverity | '')}
            disabled={editorDisabled}
            data-testid="workflow-metadata-severity"
          >
            <option value="">{t('workflowMetadata.field.severityDefaultNone')}</option>
            {RECOVERY_ITEM_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s.toUpperCase()}
              </option>
            ))}
          </select>
        </label>

        <label className="we-field">
          <span>
            {t('workflowMetadata.field.aiGuidance')}
            <span className="helper-text">
              {' '}
              ({aiGuidanceByteLength.toLocaleString(getResolvedLocale())}/{WORKFLOW_METADATA_AI_GUIDANCE_MAX_BYTES.toLocaleString(getResolvedLocale())}{' '}
              {t('workflowMetadata.field.runbookUnit')})
            </span>
          </span>
          <textarea
            rows={7}
            value={form.aiGuidanceMarkdown}
            onChange={(e) => updateForm('aiGuidanceMarkdown', e.target.value)}
            placeholder={t('workflowMetadata.field.aiGuidancePlaceholder')}
            disabled={editorDisabled}
            aria-invalid={aiGuidanceOverCap || aiGuidanceHasSecret}
            data-testid="workflow-metadata-ai-guidance"
          />
          <span className="helper-text">{t('workflowMetadata.field.aiGuidanceHelp')}</span>
          {aiGuidanceOverCap && (
            <span className="helper-text we-helper-text--error">
              {t('workflowMetadata.field.aiGuidanceOverCap')}
            </span>
          )}
          {aiGuidanceHasSecret && (
            <span className="helper-text we-helper-text--error">
              {t('workflowMetadata.field.aiGuidanceSecret')}
            </span>
          )}
        </label>

        <label className="we-field">
          <span>
            {t('workflowMetadata.field.runbook')}
            <span className="helper-text">
              {' '}
              ({runbookByteLength.toLocaleString(getResolvedLocale())}/{WORKFLOW_METADATA_RUNBOOK_MAX_BYTES.toLocaleString(getResolvedLocale())}{' '}
              {t('workflowMetadata.field.runbookUnit')})
            </span>
          </span>
          <textarea
            rows={10}
            value={form.runbookMarkdown}
            onChange={(e) => updateForm('runbookMarkdown', e.target.value)}
            placeholder={t('workflowMetadata.field.runbookPlaceholder')}
            disabled={editorDisabled}
            data-testid="workflow-metadata-runbook"
          />
          {runbookOverCap && (
            <span className="helper-text we-helper-text--error">
              {t('workflowMetadata.field.runbookOverCap')}
            </span>
          )}
        </label>

        <div className="we-workflow-metadata-panel__actions">
          <button
            type="submit"
            className="command-button command-button-primary"
            disabled={readOnly || loadState !== 'ready' || saving || runbookOverCap || aiGuidanceOverCap || aiGuidanceHasSecret}
            data-testid="workflow-metadata-save"
          >
            {saving
              ? (t('workflowMetadata.action.saving'))
              : (t('workflowMetadata.action.save'))}
          </button>
        </div>
      </form>
    </section>
  )
}
