import { Search } from 'lucide-react'
import { useState } from 'react'

import type { AiHealth, ActiveTab } from '../types'
import { useT } from '../i18n'
import { canOpenSettingsSection, SETTINGS_AREAS } from '../settings-sections'
import type { OpsSection } from './operations-section-bus'
import { EmptyView } from './panel-primitives'

export function SettingsOverview({
  permissions,
  connectionCount,
  aiHealth,
  onOpenSection,
  onOpenTab,
}: {
  permissions?: readonly string[]
  connectionCount: number
  aiHealth: AiHealth | null
  onOpenSection: (section: Exclude<OpsSection, 'overview'>) => void
  onOpenTab: (tab: ActiveTab) => void
}) {
  const { t } = useT()
  const [query, setQuery] = useState('')
  const can = (permission: string) => permissions === undefined || permissions.includes(permission)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleAreas = SETTINGS_AREAS.filter((area) => {
    if (!canOpenSettingsSection(area, permissions)) return false
    if (!normalizedQuery) return true
    return [
      t(`operations.section.${area}.label`),
      t(`operations.section.${area}.helper`),
    ]
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  })

  const statusFor = (area: Exclude<OpsSection, 'overview'>): string | null => {
    if (area === 'integrations') {
      return t('rightPanel.credentials.inventoryCount', {
        shown: connectionCount,
        total: connectionCount,
      })
    }
    if (area === 'ai') {
      if (aiHealth === null) return t('badges.health.unavailable')
      return t(aiHealth?.enabled ? 'aiStudio.healthOn' : 'aiStudio.healthOff')
    }
    return null
  }

  return (
    <section className="we-settings-index" aria-labelledby="settings-index-title">
      <div className="we-settings-index__heading">
        <div>
          <div className="section-kicker">{t('operations.kicker')}</div>
          <h3 id="settings-index-title">{t('operations.section.overview.label')}</h3>
          <p>{t('operations.section.overview.helper')}</p>
        </div>
        <label className="we-list-search we-settings-index__search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            className="text-field"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('settings.index.searchPlaceholder')}
            aria-label={t('settings.index.searchPlaceholder')}
          />
        </label>
      </div>

      {visibleAreas.length === 0 ? (
        <EmptyView
          icon={<Search size={22} />}
          title={t('settings.index.noMatches.title')}
          body={t('settings.index.noMatches.body')}
          cta={{ label: t('common.clearFilter'), onClick: () => setQuery('') }}
        />
      ) : (
        <div className="we-settings-index__grid">
          {visibleAreas.map((area) => {
            const status = statusFor(area)
            return (
              <button
                key={area}
                type="button"
                className="we-card we-settings-index__card"
                onClick={() => onOpenSection(area)}
                data-testid={`settings-index-${area}`}
              >
                <span className="we-settings-index__card-copy">
                  <strong>{t(`operations.section.${area}.label`)}</strong>
                  <span>{t(`operations.section.${area}.helper`)}</span>
                  {status && <small>{status}</small>}
                </span>
              </button>
            )
          })}
        </div>
      )}

      <div className="we-settings-index__quick-paths" aria-label={t('operations.section.railLabel')}>
        {can('credentials.read') && (
          <button type="button" className="small-command" onClick={() => onOpenTab('credentials')}>
            {t('workspace.section.credentials.label')}
          </button>
        )}
        {can('members.read') && (
          <button type="button" className="small-command" onClick={() => onOpenTab('members')}>
            {t('workspace.section.members.label')}
          </button>
        )}
      </div>
    </section>
  )
}
