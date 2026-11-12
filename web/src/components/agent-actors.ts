import { useEffect, useState } from 'react'
import { api } from '../api'
import { isRecord } from '../lib/guards'
import { currentSessionOrganization } from '../identity-context'
import { useWorkflowStore } from '../store'
import type { Translate } from '../i18n/resources'
import { getResolvedLocale } from '../i18n/runtime'

/** The signed-in person as the agent routes see them. */
export function useViewer(): { userId: string | null; isAdmin: boolean; isEditor: boolean } {
  const context = useWorkflowStore((state) => state.identityContext)
  const roleBase = currentSessionOrganization(context)?.roleBase
  return {
    userId: context?.identity.userId ?? null,
    isAdmin: roleBase === 'admin',
    isEditor: roleBase === 'admin' || roleBase === 'editor',
  }
}

/** Member emails by user id; empty when the viewer cannot read members. */
export function useMemberEmails(enabled: boolean): ReadonlyMap<string, string> {
  const [emails, setEmails] = useState<ReadonlyMap<string, string>>(() => new Map())
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    api('/members')
      .then((rows) => {
        if (cancelled || !Array.isArray(rows)) return
        const next = new Map<string, string>()
        for (const row of rows) {
          if (isRecord(row) && typeof row.userId === 'string' && typeof row.email === 'string' && row.email) {
            next.set(row.userId, row.email)
          }
        }
        setEmails(next)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [enabled])
  return emails
}

/** A person or `agent:<clientId>` actor, named for display. */
export function actorLabel(
  actor: string,
  names: { userId: string | null; emails: ReadonlyMap<string, string>; agents?: ReadonlyMap<string, string> },
  t: Translate,
): string {
  const clientId = actor.startsWith('agent:') ? actor.slice('agent:'.length) : null
  if (clientId !== null) return names.agents?.get(clientId) ?? `${t('nodes.agent.label')} ${clientId.slice(0, 8)}`
  if (actor === names.userId) return t('runExplain.you')
  return names.emails.get(actor) ?? actor
}

export function formatWhen(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(getResolvedLocale(), { dateStyle: 'medium', timeStyle: 'short' })
}
