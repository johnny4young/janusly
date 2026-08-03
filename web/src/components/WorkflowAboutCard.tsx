/**
 * Read-only "About this workflow" panel rendered inside the Recovery
 * dialog. Pulls per-workflow metadata via `GET /workflows/:id/metadata`
 * and surfaces owners, runbook, description, tags, Slack channel,
 * Linear project, and the default severity.
 *
 * Multi-tenant scope is enforced by the server (the route fails 404
 * when the workflow doesn't belong to the caller's org). The card
 * renders an empty-state CTA when no row exists so the operator knows
 * the editor's Inspector is where to set the metadata.
 *
 * Runbook Markdown flows through `<SafeMarkdown />` (which reuses the
 * same closed parser the PDF renderer uses) — operator-supplied links
 * stay clickable; the link safety guard is on by default.
 */

import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Copy } from 'lucide-react'

import type { RecoveryItemSeverity } from '@/lib/recovery-item'
import { api } from '../api'
import { useT } from '../i18n'
import { useWorkflowStore } from '../store'
import { SafeMarkdown } from './SafeMarkdown'

type WorkflowMetadataRecord = {
  workflowId: string
  owners: string[]
  runbookMarkdown: string | null
  description: string | null
  tags: string[]
  folder: string | null
  slackChannel: string | null
  linearProject: string | null
  severityDefault: RecoveryItemSeverity | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

type Props = {
  workflowId: string | null
}

const SEVERITY_TONE: Record<RecoveryItemSeverity, string> = {
  p1: 'we-recovery-item-badge__sev--p1',
  p2: 'we-recovery-item-badge__sev--p2',
  p3: 'we-recovery-item-badge__sev--p3',
  p4: 'we-recovery-item-badge__sev--p4',
}

const RUNBOOK_COLLAPSED_HEIGHT = 240

function ownerInitial(userId: string): string {
  const trimmed = userId.trim()
  return trimmed.length > 0 ? trimmed[0].toUpperCase() : '?'
}

function normalizeLinearUrl(value: string): string {
  if (value.startsWith('https://')) return value
  return `https://linear.app/${value}`
}

export function WorkflowAboutCard({ workflowId }: Props): React.ReactElement | null {
  const { t } = useT()
  const platformVersion = useWorkflowStore((s) => s.platformVersion)
  const [metadata, setMetadata] = useState<WorkflowMetadataRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [runbookExpanded, setRunbookExpanded] = useState(false)

  useEffect(() => {
    if (!workflowId) {
      setMetadata(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setLoadError(false)
    api(`/workflows/${encodeURIComponent(workflowId)}/metadata`)
      .then((payload) => {
        if (cancelled) return
        const next = (payload as { metadata?: WorkflowMetadataRecord | null } | null)?.metadata ?? null
        setMetadata(next)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setMetadata(null)
        setLoadError(true)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workflowId, platformVersion])

  const ownersDisplay = useMemo(() => {
    if (!metadata) return []
    return metadata.owners.slice(0, 3)
  }, [metadata])

  const ownersOverflow = metadata && metadata.owners.length > 3
    ? metadata.owners.length - 3
    : 0

  if (!workflowId) return null

  if (loading) {
    return (
      <section className="we-workflow-about-card we-workflow-about-card--loading" data-testid="workflow-about-card">
        <h4>{t('workflowMetadata.panel.title')}</h4>
        <p className="we-list-row__hint">{t('workflowMetadata.panel.loading')}</p>
      </section>
    )
  }

  if (loadError) {
    return (
      <section className="we-workflow-about-card we-workflow-about-card--error" data-testid="workflow-about-card">
        <h4>{t('workflowMetadata.panel.title')}</h4>
        <p className="we-list-row__hint">{t('workflowMetadata.panel.loadError')}</p>
      </section>
    )
  }

  if (!metadata) {
    return (
      <section className="we-workflow-about-card we-workflow-about-card--empty" data-testid="workflow-about-card">
        <h4>{t('workflowMetadata.panel.title')}</h4>
        <p className="we-list-row__hint">{t('workflowMetadata.panel.emptyState')}</p>
      </section>
    )
  }

  const hasAny =
    metadata.owners.length > 0 ||
    Boolean(metadata.runbookMarkdown) ||
    Boolean(metadata.description) ||
    metadata.tags.length > 0 ||
    Boolean(metadata.folder) ||
    Boolean(metadata.slackChannel) ||
    Boolean(metadata.linearProject) ||
    Boolean(metadata.severityDefault)

  if (!hasAny) {
    return (
      <section className="we-workflow-about-card we-workflow-about-card--empty" data-testid="workflow-about-card">
        <h4>{t('workflowMetadata.panel.title')}</h4>
        <p className="we-list-row__hint">{t('workflowMetadata.panel.emptyState')}</p>
      </section>
    )
  }

  return (
    <section className="we-workflow-about-card" data-testid="workflow-about-card">
      <h4>{t('workflowMetadata.panel.title')}</h4>

      {metadata.description && (
        <p className="we-workflow-about-card__description">{metadata.description}</p>
      )}

      {metadata.owners.length > 0 && (
        <div className="we-workflow-about-card__owners" data-testid="workflow-about-card-owners">
          <span className="we-list-row__hint">{t('workflowMetadata.field.owners')}</span>
          <ul className="we-workflow-about-card__owner-list">
            {ownersDisplay.map((owner) => (
              <li key={owner} title={owner}>
                <span className="we-workflow-about-card__owner-avatar">{ownerInitial(owner)}</span>
                <span className="we-workflow-about-card__owner-name">{owner}</span>
              </li>
            ))}
            {ownersOverflow > 0 && (
              <li className="we-workflow-about-card__owner-overflow">+{ownersOverflow}</li>
            )}
          </ul>
        </div>
      )}

      {metadata.severityDefault && (
        <div className="we-workflow-about-card__severity">
          <span className="we-list-row__hint">{t('workflowMetadata.field.severityDefault')}</span>
          <span
            className={`we-recovery-item-badge__sev ${SEVERITY_TONE[metadata.severityDefault]}`}
            data-testid="workflow-about-card-severity"
          >
            {t(`recoveryItems.severity.${metadata.severityDefault}`)}
          </span>
        </div>
      )}

      {metadata.folder && (
        <div className="we-workflow-about-card__folder" data-testid="workflow-about-card-folder">
          <span className="we-list-row__hint">{t('workflowMetadata.field.folder')}</span>
          <span className="we-pill" data-tone="primary">{metadata.folder}</span>
        </div>
      )}

      {metadata.tags.length > 0 && (
        <div className="we-workflow-about-card__tags" data-testid="workflow-about-card-tags">
          {metadata.tags.map((tag) => (
            <span key={tag} className="we-pill" data-tone="ghost">
              {tag}
            </span>
          ))}
        </div>
      )}

      {(metadata.slackChannel || metadata.linearProject) && (
        <div className="we-workflow-about-card__links">
          {metadata.slackChannel && (
            <div className="we-workflow-about-card__link-row" data-testid="workflow-about-card-slack">
              <span className="we-list-row__hint">{t('workflowMetadata.field.slackChannel')}</span>
              <code>{metadata.slackChannel}</code>
              <button
                type="button"
                className="we-btn we-btn--ghost we-btn--sm"
                onClick={() => {
                  if (typeof navigator !== 'undefined' && navigator.clipboard) {
                    void navigator.clipboard.writeText(metadata.slackChannel!)
                  }
                }}
                aria-label={t('workflowMetadata.action.copy')}
                title={t('workflowMetadata.action.copy')}
              >
                <Copy size={12} aria-hidden />
              </button>
            </div>
          )}
          {metadata.linearProject && (
            <div className="we-workflow-about-card__link-row" data-testid="workflow-about-card-linear">
              <span className="we-list-row__hint">{t('workflowMetadata.field.linearProject')}</span>
              <a
                href={normalizeLinearUrl(metadata.linearProject)}
                target="_blank"
                rel="noreferrer noopener"
              >
                {metadata.linearProject} <ExternalLink size={12} aria-hidden />
              </a>
            </div>
          )}
        </div>
      )}

      {metadata.runbookMarkdown && (
        <div className="we-workflow-about-card__runbook" data-testid="workflow-about-card-runbook">
          <span className="we-list-row__hint">{t('workflowMetadata.field.runbook')}</span>
          <div
            className="we-workflow-about-card__runbook-body"
            style={
              runbookExpanded
                ? undefined
                : { maxHeight: `${RUNBOOK_COLLAPSED_HEIGHT}px`, overflow: 'hidden' }
            }
          >
            <SafeMarkdown source={metadata.runbookMarkdown} allowOperatorLinks />
          </div>
          <button
            type="button"
            className="we-btn we-btn--ghost we-btn--sm"
            onClick={() => setRunbookExpanded((v) => !v)}
          >
            {runbookExpanded
              ? (t('workflowMetadata.action.collapseRunbook'))
              : (t('workflowMetadata.action.expandRunbook'))}
          </button>
        </div>
      )}
    </section>
  )
}
