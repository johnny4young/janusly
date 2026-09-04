import { ChartNoAxesCombined } from 'lucide-react'

import { getResolvedLocale, useT } from '../i18n'
import { EmptyView } from './panel-primitives'

import type { CacheEfficiency, CostProviderRow } from '../lib/recovery-metrics-model'

export type { CacheEfficiency, CostProviderRow }

export function SettingsUsageSection({
  providers,
  cache,
}: {
  providers: CostProviderRow[]
  cache: CacheEfficiency
}) {
  const { t } = useT()
  const locale = getResolvedLocale()

  if (providers.length === 0) {
    return (
      <section className="we-card we-settings-usage">
        <EmptyView
          icon={<ChartNoAxesCombined size={22} />}
          title={t('rightPanel.usage.emptyKicker')}
          body={t('rightPanel.usage.empty')}
        />
      </section>
    )
  }

  return (
    <section className="we-card we-settings-usage">
      <div className="section-kicker">{t('operations.cost.heading')}</div>
      <dl className="we-ops-cache-summary" aria-label={t('operations.cost.cache.summaryLabel')}>
        <div>
          <dt>{t('operations.cost.cache.readShare')}</dt>
          <dd>{cache.readSharePercent == null
            ? '—'
            : `${cache.readSharePercent.toLocaleString(locale, { maximumFractionDigits: 1 })}%`}</dd>
        </div>
        <div>
          <dt>{t('operations.cost.cache.readTokens')}</dt>
          <dd>{cache.readTokens.toLocaleString(locale)}</dd>
        </div>
        <div>
          <dt>{t('operations.cost.cache.creationTokens')}</dt>
          <dd>{cache.creationTokens.toLocaleString(locale)}</dd>
        </div>
      </dl>
      <div
        className="we-ops-cost-table-wrap"
        data-testid="settings-usage-cost-table"
        role="region"
        aria-label={t('operations.cost.tableAria')}
        tabIndex={0}
      >
        <table className="we-ops-cost-table">
          <thead>
            <tr>
              <th>{t('operations.cost.col.provider')}</th>
              <th>{t('operations.cost.col.model')}</th>
              <th>{t('operations.cost.col.usd')}</th>
              <th>{t('operations.cost.col.tokens')}</th>
              <th>{t('operations.cost.col.cacheRead')}</th>
              <th>{t('operations.cost.col.cacheCreated')}</th>
              <th>{t('operations.cost.col.calls')}</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((row) => (
              <tr key={`${row.aggregated ? 'aggregate' : 'detail'}::${row.provider}::${row.model}`}>
                <td>{row.aggregated ? t('operations.cost.otherProviderModel') : row.provider}</td>
                <td>{row.aggregated ? '—' : <code>{row.model}</code>}</td>
                <td>${row.usd.toFixed(4)}</td>
                <td>{row.tokens.toLocaleString(locale)}</td>
                <td>{row.cachedInputTokens.toLocaleString(locale)}</td>
                <td>{row.cacheCreationInputTokens.toLocaleString(locale)}</td>
                <td>{row.calls.toLocaleString(locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
