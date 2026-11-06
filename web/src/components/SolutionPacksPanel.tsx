/**
 * Solution-packs catalog panel — installable, ICP-shaped workflow starters.
 *
 * Presentational, mirroring `TemplatesPanel` / `ToolsPanel` in
 * `RightPanel.tsx`: the catalog + the three action handlers are passed in
 * from `App.tsx` (which owns the `api()` calls + navigation). The readiness
 * checklist compares required credentials against the already-fetched
 * `credentials` list and one `/credentials/health` read, so there's no per-pack
 * or per-row fetch.
 *
 * Used by `RightPanel.tsx` as a standalone compatibility route and embedded
 * in the unified Templates catalog.
 *
 * Invariants:
 * - The secret VALUE / env-var name never reaches this surface — packs
 *   declare only the operator-chosen credential `name` + `kind`.
 * - All copy goes through `useT()`; no raw string literals.
 */

import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, Bug, CheckCircle2, Download, Package, Play, Search, Settings, ShieldCheck } from 'lucide-react'
import { api } from '../api'
import { expiryStatus } from '../credential-expiry'
import type { Credential, PackRequiredCredential, SolutionPackPublic } from '../types'
import type { CreateCredential } from './CredentialCreateDialog'
import { loadConnectionDialogs } from './panel-loaders'
import { EmptyView, PanelChrome, PanelSearch } from './panel-primitives'
import { useWorkflowStore } from '../store'
import { useT } from '../i18n'
import { Button } from '@/components/ui/Button'
import { FieldLabel, SelectControl } from '@/components/ui/Form'
import './SolutionPacksPanel.css'

const NO_HEALTH = { managedStorageAvailable: true, unsetNames: [] as string[] }

const PackConnectDialog = lazy(() => loadConnectionDialogs().then((m) => ({ default: m.PackConnectDialog })))

type SolutionPacksPanelProps = {
  packs: SolutionPackPublic[]
  credentials: Credential[]
  /** False until a list was read for this organization, or when the role can't read one: `credentials` then proves nothing. */
  credentialsKnown?: boolean
  onInstall: (packId: string) => void
  onSampleRun: (packId: string) => void
  onInjectFailure: (packId: string, fixtureId: string) => void
  /** Omitted when the role can't create credentials: the checklist then has no Connect. */
  onCreateCredential?: CreateCredential
  canInstall?: boolean
  embedded?: boolean
  query?: string
  onQueryChange?: (value: string) => void
  showSearch?: boolean
}

export function SolutionPacksPanel({
  packs,
  credentials,
  credentialsKnown = true,
  onInstall,
  onSampleRun,
  onInjectFailure,
  onCreateCredential,
  canInstall = true,
  embedded = false,
  query: controlledQuery,
  onQueryChange,
  showSearch = true,
}: SolutionPacksPanelProps) {
  const { t, i18n } = useT()
  const setActiveTab = useWorkflowStore((state) => state.setActiveTab)
  const [internalQuery, setInternalQuery] = useState('')
  const [selectedDrills, setSelectedDrills] = useState<Record<string, string>>({})
  const [connecting, setConnecting] = useState<{ packId: string; credential: PackRequiredCredential } | null>(null)
  const [health, setHealth] = useState(NO_HEALTH)
  const query = controlledQuery ?? internalQuery
  const setQuery = onQueryChange ?? setInternalQuery

  useEffect(() => {
    if (!credentialsKnown) {
      setHealth(NO_HEALTH)
      return
    }
    let cancelled = false
    api('/credentials/health').then(
      (response) => {
        if (cancelled) return
        const body = response as { managedStorageAvailable?: boolean; credentials?: { name: string; secretRefPresent: boolean }[] } | null
        const entries = Array.isArray(body?.credentials) ? body.credentials : []
        setHealth({
          managedStorageAvailable: body?.managedStorageAvailable === true,
          unsetNames: entries.filter((c) => !c.secretRefPresent).map((c) => c.name),
        })
      },
      () => {
        if (!cancelled) setHealth((current) => ({ ...current, managedStorageAvailable: false }))
      },
    )
    return () => { cancelled = true }
  }, [credentials, credentialsKnown])

  // Once the list holds the name, by this create or anyone else's, a create can only conflict.
  if (connecting && credentials.some((c) => c.name === connecting.credential.name)) setConnecting(null)

  const credentialState = (cred: PackRequiredCredential) => {
    if (!credentialsKnown) return 'unknown'
    // Names are unique per org, so a create would conflict with a credential of another kind.
    const held = credentials.find((c) => c.name === cred.name)
    if (!held) return 'missing'
    if (held.kind !== cred.kind) return 'wrongKind'
    if (expiryStatus(held.expiresAt, Date.now()).kind === 'expired') return 'expired'
    return health.unsetNames.includes(cred.name) ? 'unset' : 'ready'
  }
  const packText = (pack: SolutionPackPublic, key: string, defaultValue: string) => t(`packs.${pack.id}.${key}`, { defaultValue })
  const q = query.trim().toLowerCase()
  const filtered = q
    ? packs.filter((pack) => {
      return [
        packText(pack, 'name', pack.name),
        packText(pack, 'description', pack.description),
        t(`packs.category.${pack.category}`, { defaultValue: pack.category }),
        ...pack.failureFixtures.flatMap((fixture) => [
          packText(pack, `drills.${fixture.id}.label`, fixture.label),
          packText(pack, `drills.${fixture.id}.description`, fixture.description),
          t(`packs.drill.mode.${fixture.failureMode}`, { defaultValue: fixture.failureMode }),
        ]),
      ].join(' ').toLowerCase().includes(q)
    })
    : packs

  const chrome = (children: ReactNode) => embedded
    ? children
    : <PanelChrome title={t('packs.title')} description={t('packs.description')}>{children}</PanelChrome>

  if (packs.length === 0) {
    const empty = (
      <div className="panel-list">
        <EmptyView
          icon={<Package size={22} />}
          title={t('packs.empty.title')}
          body={t('packs.empty.body')}
          cta={embedded ? undefined : { label: t('packs.empty.cta'), onClick: () => setActiveTab('templates') }}
        />
      </div>
    )
    return chrome(empty)
  }

  const content = (
    <>
      {showSearch && <PanelSearch value={query} onChange={setQuery} placeholder={t('packs.searchPlaceholder')} />}
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
          const categoryLabel = t(`packs.category.${pack.category}`, { defaultValue: pack.category })
          const selectedFixture = pack.failureFixtures.find((fixture) => fixture.id === selectedDrills[pack.id])
            ?? pack.failureFixtures[0]
          const drillDescriptionId = `pack-drill-description-${pack.id}`
          const notReady = pack.requiredCredentials.filter((cred) => credentialState(cred) !== 'ready')
          const checkTitleId = `pack-check-title-${pack.id}`
          // Credentials that aren't ready never block Install: a pack installs as a draft and is wired afterwards,
          // and installing needs a lower role than connecting. They only take away its primary weight.
          const installNote = !canInstall
            ? t('packs.installNote.role')
            : credentialsKnown && notReady.length > 0 && t('packs.installNote.setup', {
              names: new Intl.ListFormat(i18n.language).format(notReady.map((cred) => cred.name)),
            })
          const installNoteId = `pack-note-${pack.id}`
          return (
            <div key={pack.id} className="list-card" data-testid={`solution-pack-${pack.id}`}>
              <div className="split-row" style={{ width: '100%' }}>
                <span className="mode-pill mode-pill-neutral">{categoryLabel}</span>
                <span className="mode-pill mode-pill-neutral">{t('packs.stepCount', { count: pack.nodeCount })}</span>
              </div>
              <strong>{packText(pack, 'name', pack.name)}</strong>
              <span>{packText(pack, 'description', pack.description)}</span>
              {pack.assurance.intentContract && (
                <div
                  className="we-pack-pills"
                  data-testid={`pack-assurance-${pack.id}`}
                  aria-label={t('packs.assurance.aria')}
                >
                  <span className="mode-pill mode-pill-ai">
                    <ShieldCheck size={11} aria-hidden="true" /> {t('packs.assurance.intent')}
                  </span>
                  {pack.assurance.recoveryContractVersion && (
                    <span className="mode-pill mode-pill-ai">
                      {t('packs.assurance.recovery', { version: pack.assurance.recoveryContractVersion })}
                    </span>
                  )}
                  {pack.assurance.qualificationFixtureCount > 0 && (
                    <span className="mode-pill mode-pill-ai">
                      {t('packs.assurance.qualification', { count: pack.assurance.qualificationFixtureCount })}
                    </span>
                  )}
                </div>
              )}

              {(pack.requiredCredentials.length > 0 || pack.requiredOrgConfigs.length > 0) && (
                <section className="we-pack-check" aria-labelledby={checkTitleId} tabIndex={-1}>
                  <h4 className="ui-field__label" id={checkTitleId}>
                    <span>
                      {t('packs.check.title')}
                      {credentialsKnown && pack.requiredCredentials.length > 0 && ` · ${t('packs.check.progress', {
                        ready: pack.requiredCredentials.length - notReady.length,
                        count: pack.requiredCredentials.length,
                      })}`}
                    </span>
                  </h4>
                  <ul className="we-pack-check__list">
                    {pack.requiredCredentials.map((cred) => {
                      const state = credentialState(cred)
                      const stateText = t(`packs.check.${state}`, { kind: credentials.find((c) => c.name === cred.name)?.kind })
                      const statusLabel = t('packs.credential.state', { name: cred.name, kind: cred.kind, state: stateText })
                      const action = state === 'missing'
                        ? onCreateCredential && 'connect'
                        : state !== 'ready' && state !== 'unknown' && 'review'
                      return (
                        <li
                          key={`cred-${cred.name}`}
                          className="we-pack-check__row"
                          data-state={state}
                          title={`${statusLabel} - ${cred.purpose}`}
                          aria-label={statusLabel}
                        >
                          {state === 'ready'
                            ? <CheckCircle2 size={14} aria-hidden="true" />
                            : <AlertTriangle size={14} aria-hidden="true" />}
                          <code>{cred.name}</code>
                          <span>{stateText}</span>
                          {action && (
                            <Button
                              size="sm"
                              className="we-pack-check__action"
                              data-testid={`pack-${action}-${pack.id}-${cred.name}`}
                              aria-label={t(`packs.action.${action}Name`, { name: cred.name })}
                              onClick={() => (action === 'connect'
                                ? setConnecting((current) => current ?? { packId: pack.id, credential: cred })
                                : setActiveTab('credentials'))}
                            >
                              {t(`packs.action.${action}`)}
                            </Button>
                          )}
                        </li>
                      )
                    })}
                    {pack.requiredOrgConfigs.map((cfg) => (
                      <li
                        key={`cfg-${cfg.key}`}
                        className="we-pack-check__row"
                        title={cfg.purpose}
                      >
                        <Settings size={14} aria-hidden="true" />
                        <code>{cfg.key}</code>
                        <span>{t('packs.check.orgConfig')}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <div className="form-actions">
                <Button
                  variant={notReady.length === 0 ? 'primary' : 'secondary'}
                  disabled={!canInstall}
                  data-testid={`pack-install-${pack.id}`}
                  aria-describedby={installNote ? installNoteId : undefined}
                  onClick={() => onInstall(pack.id)}
                >
                  <Download size={13} aria-hidden="true" /> {t('packs.action.install')}
                </Button>
                <Button disabled={!canInstall} onClick={() => onSampleRun(pack.id)}>
                  <Play size={13} aria-hidden="true" /> {t('packs.action.sampleRun')}
                </Button>
              </div>
              {installNote && (
                <small className="helper-text" id={installNoteId} data-testid={installNoteId}>
                  {installNote}
                </small>
              )}

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
                  <FieldLabel  htmlFor={`pack-drill-${pack.id}`}>
                    {t('packs.drill.scenarioLabel')}
                  </FieldLabel>
                  <SelectControl
                    id={`pack-drill-${pack.id}`}
                    className="we-pack-drill__select"
                    value={selectedFixture.id}
                    disabled={!canInstall}
                    aria-describedby={drillDescriptionId}
                    data-testid={`pack-drill-select-${pack.id}`}
                    onChange={(event) => setSelectedDrills((current) => ({
                      ...current,
                      [pack.id]: event.target.value,
                    }))}
                  >
                    {pack.failureFixtures.map((fixture) => (
                      <option key={fixture.id} value={fixture.id}>
                        {packText(pack, `drills.${fixture.id}.label`, fixture.label)}
                      </option>
                    ))}
                  </SelectControl>
                  <div className="we-pack-drill__summary" id={drillDescriptionId} aria-live="polite">
                    <div className="we-pack-pills">
                      <span className="mode-pill mode-pill-neutral">
                        {t(`packs.drill.mode.${selectedFixture.failureMode}`, { defaultValue: selectedFixture.failureMode })}
                      </span>
                      <span className="mode-pill mode-pill-neutral">
                        {t(`packs.drill.path.${selectedFixture.recoveryPath}`)}
                      </span>
                    </div>
                    <p className="helper-text">
                      {packText(pack, `drills.${selectedFixture.id}.description`, selectedFixture.description)}
                    </p>
                  </div>
                  <Button
                    className="we-pack-drill__action"
                    disabled={!canInstall}
                    data-testid={`pack-drill-start-${pack.id}`}
                    onClick={() => onInjectFailure(pack.id, selectedFixture.id)}
                  >
                    <Bug size={13} aria-hidden="true" /> {t('packs.action.startDrill')}
                  </Button>
                </section>
              )}
            </div>
          )
        })}
      </div>
      {connecting && onCreateCredential && (
        <Suspense fallback={null}>
          <PackConnectDialog
            {...connecting}
            onCreate={onCreateCredential}
            onClose={() => setConnecting(null)}
            managedStorageAvailable={health.managedStorageAvailable}
          />
        </Suspense>
      )}
    </>
  )

  return chrome(content)
}
