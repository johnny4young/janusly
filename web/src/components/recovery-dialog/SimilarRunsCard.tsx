/**
 * Progressive "similar past failures" card for the recovery Review step.
 *
 * Queries the semantic run search (`/runs/semantic-search`) with the
 * failure signature. The feature is consent-gated server-side: when
 * memory is disabled, the search answers `{enabled:false}` and this card
 * renders nothing — no empty states, no nagging to enable memory here.
 */

import { useEffect, useState } from 'react'
import { History } from 'lucide-react'
import { api } from '../../api'
import { useT } from '../../i18n'

type SimilarRun = {
  id: string
  content: string
  similarity: number
  runId?: string
  metadata?: Record<string, unknown>
}

const MAX_SHOWN = 3

function parseEntries(payload: unknown): SimilarRun[] {
  if (!payload || typeof payload !== 'object') return []
  const body = payload as { enabled?: unknown; entries?: unknown }
  if (body.enabled !== true || !Array.isArray(body.entries)) return []
  const rows: SimilarRun[] = []
  for (const raw of body.entries) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    if (typeof entry.id !== 'string' || typeof entry.content !== 'string') continue
    if (typeof entry.similarity !== 'number') continue
    rows.push({
      id: entry.id,
      content: entry.content,
      similarity: entry.similarity,
      runId: typeof entry.runId === 'string' ? entry.runId : undefined,
      metadata: entry.metadata && typeof entry.metadata === 'object'
        ? (entry.metadata as Record<string, unknown>)
        : undefined,
    })
  }
  return rows
}

export function SimilarRunsCard({ failureSignature }: { failureSignature: string }) {
  const { t } = useT()
  const [entries, setEntries] = useState<SimilarRun[]>([])

  useEffect(() => {
    if (!failureSignature.trim()) return
    let cancelled = false
    api(`/runs/semantic-search?q=${encodeURIComponent(failureSignature)}`)
      .then((payload) => {
        if (!cancelled) setEntries(parseEntries(payload))
      })
      .catch(() => {
        // Best-effort telemetry surface: absence is the correct fallback.
        if (!cancelled) setEntries([])
      })
    return () => {
      cancelled = true
    }
  }, [failureSignature])

  if (entries.length === 0) return null

  return (
    <section className="we-similar-runs" data-testid="recovery-similar-runs">
      <header className="we-similar-runs__header">
        <History size={14} aria-hidden="true" />
        <span className="section-kicker">{t('recoveryDialog.similarRuns.kicker')}</span>
      </header>
      <ul className="we-similar-runs__list">
        {entries.slice(0, MAX_SHOWN).map((entry) => (
          <li key={entry.id}>
            <span className="we-similar-runs__content">{entry.content}</span>
            <span className="we-similar-runs__match">
              {t('recoveryDialog.similarRuns.match', {
                percent: Math.round(Math.max(0, Math.min(1, entry.similarity)) * 100),
              })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
