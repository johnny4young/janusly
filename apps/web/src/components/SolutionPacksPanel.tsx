/**
 * Solution-packs catalog panel — installable, ICP-shaped workflow starters.
 *
 * Presentational, mirroring `TemplatesPanel` / `ToolsPanel` in
 * `RightPanel.tsx`: the catalog + the three action handlers are passed in
 * from `App.tsx` (which owns the `api()` calls + navigation). Required-
 * credential chips turn amber when the org has no credential with that kind/name —
 * computed client-side against the already-fetched `credentials` list, so
 * there's no per-pack detail fetch.
 *
 * Used by `RightPanel.tsx` (tab === 'packs').
 *
 * Invariants:
 * - The secret VALUE / env-var name never reaches this surface — packs
 *   declare only the operator-chosen credential `name` + `kind`.
 * - All copy goes through `useT()`; no raw string literals.
 */

import { useMemo, useState } from 'react'
import { AlertTriangle, Bug, Download, KeyRound, Package, Play, Search } from 'lucide-react'
import type { Credential, SolutionPackPublic } from '../types'
import { EmptyView, PanelChrome, PanelSearch } from './panel-primitives'
import { useWorkflowStore } from '../store'
import { useT } from '../i18n'

type SolutionPacksPanelProps = {
  packs: SolutionPackPublic[]
  credentials: Credential[]
  onInstall: (packId: string) => void
  onSampleRun: (packId: string) => void
  onInjectFailure: (packId: string, fixtureId: string) => void
}

export function SolutionPacksPanel({ packs, credentials, onInstall, onSampleRun, onInjectFailure }: SolutionPacksPanelProps) {
  const { t, i18n } = useT()
  const setActiveTab = useWorkflowStore((state) => state.setActiveTab)
  const [query, setQuery] = useState('')
  const [selectedDrills, setSelectedDrills] = useState<Record<string, string>>({})
  const credentialKeys = new Set(credentials.map((c) => `${c.kind}:${c.name}`))
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return packs
    return packs.filter((pack) => {
      const packName = t(`packs.${pack.id}.name`, { defaultValue: pack.name })
      const packDescription = t(`packs.${pack.id}.description`, { defaultValue: pack.description })
      const categoryLabel = t(`packs.category.${pack.category}`, { defaultValue: pack.category })
      const drills = pack.failureFixtures.map((fixture) => [
        t(`packs.${pack.id}.drills.${fixture.id}.label`, { defaultValue: fixture.label }),
        t(`packs.${pack.id}.drills.${fixture.id}.description`, { defaultValue: fixture.description }),
        t(`packs.drill.mode.${fixture.failureMode}`, { defaultValue: fixture.failureMode }),
      ].join(' ')).join(' ')
      return `${packName} ${packDescription} ${categoryLabel} ${drills}`.toLowerCase().includes(q)
    })
  }, [packs, query, t, i18n.language])

  if (packs.length === 0) {
    return (
      <PanelChrome title={t('packs.title')} description={t('packs.description')} icon={<Package size={18} />}>
        <div className="panel-list">
          <EmptyView
            icon={<Package size={22} />}
            title={t('packs.empty.title')}
            body={t('packs.empty.body')}
            cta={{ label: t('packs.empty.cta'), onClick: () => setActiveTab('templates') }}
          />
        </div>
      </PanelChrome>
    )
  }

  return (
    <PanelChrome title={t('packs.title')} description={t('packs.description')} icon={<Package size={18} />}>
      <PanelSearch value={query} onChange={setQuery} placeholder={t('packs.searchPlaceholder')} />
      {filtered.length === 0 && (
        <div className="panel-list">
          <EmptyView
            icon={<Search size={22} />}
            title={t('packs.noMatches.title')}
            body={t('packs.noMatches.body')}
            cta={{ label: t('common.clearFilter'), onClick: () => setQuery('') }}
          />
        </div>
      )}
      <div className="we-recipe-grid">
        {filtered.map((pack) => {
          const packName = t(`packs.${pack.id}.name`, { defaultValue: pack.name })
          const packDescription = t(`packs.${pack.id}.description`, { defaultValue: pack.description })
          const categoryLabel = t(`packs.category.${pack.category}`, { defaultValue: pack.category })
          const requestedFixtureId = selectedDrills[pack.id]
          const selectedFixture = pack.failureFixtures.find((fixture) => fixture.id === requestedFixtureId)
            ?? pack.failureFixtures[0]
          const drillDescriptionId = `pack-drill-description-${pack.id}`
          return (
            <div key={pack.id} className="list-card">
              <div className="split-row" style={{ width: '100%' }}>
                <span className="mode-pill mode-pill-neutral">{categoryLabel}</span>
                <span className="mode-pill mode-pill-neutral">{t('packs.stepCount', { count: pack.nodeCount })}</span>
              </div>
              <strong>{packName}</strong>
              <span>{packDescription}</span>

              {(pack.requiredCredentials.length > 0 || pack.requiredOrgConfigs.length > 0) && (
                <>
                  <span className="field-label">{t('packs.requires')}</span>
                  <div className="we-tool-params">
                    {pack.requiredCredentials.map((cred) => {
                      const missing = !credentialKeys.has(`${cred.kind}:${cred.name}`)
                      const statusLabel = t(
                        missing ? 'packs.credential.missing' : 'packs.credential.ready',
                        { name: cred.name, kind: cred.kind },
                      )
                      return (
                        <span
                          key={`cred-${cred.name}`}
                          className={`we-param ${missing ? 'we-param--missing' : 'we-param--optional'}`}
                          title={`${statusLabel} - ${cred.purpose}`}
                          aria-label={statusLabel}
                        >
                          {missing
                            ? <AlertTriangle size={11} aria-hidden="true" />
                            : <KeyRound size={11} aria-hidden="true" />}
                          {' '}{cred.name}
                        </span>
                      )
                    })}
                    {pack.requiredOrgConfigs.map((cfg) => (
                      <span key={`cfg-${cfg.key}`} className="we-param we-param--optional" title={cfg.purpose}>{cfg.key}</span>
                    ))}
                  </div>
                  {pack.requiredCredentials.length > 0 && (
                    <small className="helper-text we-pack-cred-legend">
                      <span>
                        <AlertTriangle size={10} aria-hidden="true" /> {t('packs.credential.legendMissing')}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        <KeyRound size={10} aria-hidden="true" /> {t('packs.credential.legendReady')}
                      </span>
                    </small>
                  )}
                </>
              )}

              <div className="form-actions">
                <button type="button" className="command-button command-button-primary" onClick={() => onInstall(pack.id)}>
                  <Download size={13} aria-hidden="true" /> {t('packs.action.install')}
                </button>
                <button type="button" className="command-button" onClick={() => onSampleRun(pack.id)}>
                  <Play size={13} aria-hidden="true" /> {t('packs.action.sampleRun')}
                </button>
              </div>

              {selectedFixture && (
                <section className="we-pack-drill" aria-labelledby={`pack-drill-title-${pack.id}`}>
                  <div className="we-pack-drill__header">
                    <strong id={`pack-drill-title-${pack.id}`}>
                      <Bug size={14} aria-hidden="true" /> {t('packs.drill.title')}
                    </strong>
                    <span className="mode-pill mode-pill-neutral">
                      {t('packs.drill.count', { count: pack.failureFixtures.length })}
                    </span>
                  </div>
                  <p className="helper-text">{t('packs.drill.helper')}</p>
                  <label className="field-label" htmlFor={`pack-drill-${pack.id}`}>
                    {t('packs.drill.scenarioLabel')}
                  </label>
                  <select
                    id={`pack-drill-${pack.id}`}
                    className="text-field text-field--compact we-pack-drill__select"
                    value={selectedFixture.id}
                    aria-describedby={drillDescriptionId}
                    data-testid={`pack-drill-select-${pack.id}`}
                    onChange={(event) => setSelectedDrills((current) => ({
                      ...current,
                      [pack.id]: event.target.value,
                    }))}
                  >
                    {pack.failureFixtures.map((fixture) => (
                      <option key={fixture.id} value={fixture.id}>
                        {t(`packs.${pack.id}.drills.${fixture.id}.label`, { defaultValue: fixture.label })}
                      </option>
                    ))}
                  </select>
                  <div className="we-pack-drill__summary" id={drillDescriptionId} aria-live="polite">
                    <div className="we-pack-pills">
                      <span className="mode-pill mode-pill-neutral">
                        {t(`packs.drill.mode.${selectedFixture.failureMode}`, {
                          defaultValue: selectedFixture.failureMode,
                        })}
                      </span>
                      <span className="mode-pill mode-pill-neutral">
                        {t(`packs.drill.path.${selectedFixture.recoveryPath}`)}
                      </span>
                    </div>
                    <p className="helper-text">
                      {t(`packs.${pack.id}.drills.${selectedFixture.id}.description`, {
                        defaultValue: selectedFixture.description,
                      })}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="command-button we-pack-drill__action"
                    data-testid={`pack-drill-start-${pack.id}`}
                    onClick={() => onInjectFailure(pack.id, selectedFixture.id)}
                  >
                    <Bug size={13} aria-hidden="true" /> {t('packs.action.startDrill')}
                  </button>
                </section>
              )}
            </div>
          )
        })}
      </div>
    </PanelChrome>
  )
}
