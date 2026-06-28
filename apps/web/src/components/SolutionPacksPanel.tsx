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

import { AlertTriangle, Bug, Download, KeyRound, Package, Play } from 'lucide-react'
import type { Credential, SolutionPackPublic } from '../types'
import { EmptyView, PanelChrome } from './panel-primitives'
import { useT } from '../i18n'

type SolutionPacksPanelProps = {
  packs: SolutionPackPublic[]
  credentials: Credential[]
  onInstall: (packId: string) => void
  onSampleRun: (packId: string) => void
  onInjectFailure: (packId: string) => void
}

export function SolutionPacksPanel({ packs, credentials, onInstall, onSampleRun, onInjectFailure }: SolutionPacksPanelProps) {
  const { t } = useT()
  const credentialKeys = new Set(credentials.map((c) => `${c.kind}:${c.name}`))

  return (
    <PanelChrome title={t('packs.title') as string} description={t('packs.description') as string} icon={<Package size={18} />}>
      {packs.length === 0 && (
        <div className="panel-list">
          <EmptyView icon={<Package size={22} />} title={t('packs.empty.title') as string} body={t('packs.empty.body') as string} />
        </div>
      )}
      <div className="we-recipe-grid">
        {packs.map((pack) => {
          const packName = t(`packs.${pack.id}.name`, { defaultValue: pack.name }) as string
          const packDescription = t(`packs.${pack.id}.description`, { defaultValue: pack.description }) as string
          const categoryLabel = t(`packs.category.${pack.category}`, { defaultValue: pack.category }) as string
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
                      ) as string
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
                      <AlertTriangle size={10} aria-hidden="true" /> {t('packs.credential.legendMissing')}
                      {' · '}
                      <KeyRound size={10} aria-hidden="true" /> {t('packs.credential.legendReady')}
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
                <button type="button" className="command-button" onClick={() => onInjectFailure(pack.id)}>
                  <Bug size={13} aria-hidden="true" /> {t('packs.action.breakNode')}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </PanelChrome>
  )
}
