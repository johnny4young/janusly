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

import { useEffect, useState } from 'react'

import {
  RECOVERY_ITEM_SEVERITIES,
  type RecoveryItemSeverity,
} from '@janusly/shared/src/recovery-item'
import { api } from '../api'
import { getResolvedLocale, tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'

type WorkflowMetadataForm = {
  owners: string[]
  runbookMarkdown: string
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
  description: '',
  tags: [],
  folder: '',
  slackChannel: '',
  linearProject: '',
  severityDefault: '',
}

const WORKFLOW_METADATA_FOLDER_MAX_LENGTH = 60

const WORKFLOW_METADATA_RUNBOOK_MAX_BYTES = 32 * 1024

function parseChipList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

export type WorkflowMetadataPanelProps = {
  workflowId?: string | undefined
}

export function WorkflowMetadataPanel({ workflowId: explicit }: WorkflowMetadataPanelProps = {}) {
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

  const [form, setForm] = useState<WorkflowMetadataForm>(EMPTY_FORM)
  const [ownersRaw, setOwnersRaw] = useState('')
  const [tagsRaw, setTagsRaw] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!workflowId) return
    let cancelled = false
    setLoading(true)
    api(`/workflows/${encodeURIComponent(workflowId)}/metadata`)
      .then((payload) => {
        if (cancelled) return
        const metadata = (payload as { metadata?: WorkflowMetadataForm | null } | null)?.metadata
        if (metadata) {
          const next: WorkflowMetadataForm = {
            owners: metadata.owners ?? [],
            runbookMarkdown: metadata.runbookMarkdown ?? '',
            description: metadata.description ?? '',
            tags: metadata.tags ?? [],
            folder: metadata.folder ?? '',
            slackChannel: metadata.slackChannel ?? '',
            linearProject: metadata.linearProject ?? '',
            severityDefault: metadata.severityDefault ?? '',
          }
          setForm(next)
          setOwnersRaw(next.owners.join(', '))
          setTagsRaw(next.tags.join(', '))
        } else {
          setForm(EMPTY_FORM)
          setOwnersRaw('')
          setTagsRaw('')
        }
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setForm(EMPTY_FORM)
        setOwnersRaw('')
        setTagsRaw('')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workflowId, platformVersion])

  if (!workflowId) return null

  async function onSave(e: React.FormEvent) {
    e.preventDefault()
    if (!workflowId || saving) return
    setSaving(true)
    try {
      const metadata = {
        owners: parseChipList(ownersRaw),
        runbookMarkdown: form.runbookMarkdown.trim().length > 0 ? form.runbookMarkdown : null,
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

  return (
    <section className="panel-card we-workflow-metadata-panel" aria-labelledby="we-workflow-metadata-title">
      <h3 id="we-workflow-metadata-title" className="section-title">
        {t('workflowMetadata.panel.title')}
      </h3>
      <p className="helper-text">{t('workflowMetadata.panel.description')}</p>
      <form className="we-workflow-metadata-panel__form" onSubmit={onSave}>
        <label className="we-field">
          <span>{t('workflowMetadata.field.owners')}</span>
          <input
            type="text"
            value={ownersRaw}
            onChange={(e) => setOwnersRaw(e.target.value)}
            placeholder={t('workflowMetadata.field.ownersPlaceholder')}
            disabled={loading || saving}
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
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            disabled={loading || saving}
          />
        </label>

        <label className="we-field">
          <span>{t('workflowMetadata.field.tags')}</span>
          <input
            type="text"
            value={tagsRaw}
            onChange={(e) => setTagsRaw(e.target.value)}
            placeholder={t('workflowMetadata.field.tagsPlaceholder')}
            disabled={loading || saving}
          />
        </label>

        <label className="we-field">
          <span>{t('workflowMetadata.field.folder')}</span>
          <input
            type="text"
            value={form.folder}
            maxLength={WORKFLOW_METADATA_FOLDER_MAX_LENGTH}
            onChange={(e) => setForm({ ...form, folder: e.target.value })}
            placeholder={t('workflowMetadata.field.folderPlaceholder')}
            disabled={loading || saving}
            data-testid="workflow-metadata-folder"
          />
        </label>

        <label className="we-field">
          <span>{t('workflowMetadata.field.slackChannel')}</span>
          <input
            type="text"
            value={form.slackChannel}
            maxLength={80}
            onChange={(e) => setForm({ ...form, slackChannel: e.target.value })}
            placeholder={t('workflowMetadata.field.slackChannelPlaceholder')}
            disabled={loading || saving}
          />
        </label>

        <label className="we-field">
          <span>{t('workflowMetadata.field.linearProject')}</span>
          <input
            type="text"
            value={form.linearProject}
            maxLength={200}
            onChange={(e) => setForm({ ...form, linearProject: e.target.value })}
            placeholder={t('workflowMetadata.field.linearProjectPlaceholder')}
            disabled={loading || saving}
          />
        </label>

        <label className="we-field">
          <span>{t('workflowMetadata.field.severityDefault')}</span>
          <select
            value={form.severityDefault}
            onChange={(e) =>
              setForm({
                ...form,
                severityDefault: e.target.value as RecoveryItemSeverity | '',
              })
            }
            disabled={loading || saving}
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
            onChange={(e) => setForm({ ...form, runbookMarkdown: e.target.value })}
            placeholder={t('workflowMetadata.field.runbookPlaceholder')}
            disabled={loading || saving}
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
            disabled={loading || saving || runbookOverCap}
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
