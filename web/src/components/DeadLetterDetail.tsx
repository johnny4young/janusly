import { useState } from 'react'
import { Copy, Download, FlaskConical, GitCompare, Sparkles } from 'lucide-react'

import { formatStatusLabel } from '../constants'
import { getResolvedLocale, useT } from '../i18n'
import type { DeadLetter } from './dead-letter-types'
import { RecoveryDrillOutcomeCard } from './recovery/RecoveryDrillOutcomeCard'
import { WorkflowDiffView } from './WorkflowDiffView'

type DeadLetterDetailProps = {
  selection: {
    requestedNotFound: boolean
    selectionMode: boolean
    selected: DeadLetter | null
    selectedFull: DeadLetter | null
    selectedDetailReady: boolean
    replayingIds: ReadonlySet<string>
    showSuspectDiff: boolean
  }
  permissions: {
    canReplay: boolean
    canResolve: boolean
    canStartRuns: boolean
    canUseRecovery: boolean
  }
  actions: {
    startRecovery: (item: DeadLetter) => void
    replaySelected: () => Promise<void>
    resolveSelected: () => Promise<void>
    copySelectedError: () => Promise<void>
    openReplayLab: (runId: string) => void
    exportRunExplain: () => Promise<void>
    toggleSuspectDiff: () => void
  }
}

/** Render the selected failure's actions and bounded diagnostic evidence. */
export function DeadLetterDetail({
  selection,
  permissions,
  actions,
}: DeadLetterDetailProps) {
  const { t } = useT()
  const {
    requestedNotFound,
    selectionMode,
    selected,
    selectedFull,
    selectedDetailReady,
    replayingIds,
    showSuspectDiff,
  } = selection
  const { canReplay, canResolve, canStartRuns, canUseRecovery } = permissions

  return (
    <>
      {requestedNotFound && !selectionMode && (
        <section className="detail-box" data-testid="dlq-requested-not-found">
          <div className="section-kicker">{t('dlq.selected')}</div>
          <p className="helper-text">{t('dlq.deepLinkNotFound')}</p>
        </section>
      )}

      {selected && !selectionMode && (
        <section className="detail-box">
          <div className="split-row">
            <div>
              <div className="section-kicker">{t('dlq.selected')}</div>
              <strong>{selected.nodeId}</strong>
            </div>
            <span className="status-pill" data-status={replayingIds.has(selected.id) ? 'running' : selected.status}>
              {replayingIds.has(selected.id) ? t('dlq.recovering') : formatStatusLabel(selected.status)}
            </span>
          </div>

          <div className="split-row">
            {canUseRecovery && (
              <button
                className="small-command small-command--primary"
                disabled={
                  selected.status === 'replayed'
                  || selected.status === 'resolved'
                  || !selectedDetailReady
                }
                onClick={() => {
                  if (selectedDetailReady && selectedFull) {
                    actions.startRecovery(selectedFull)
                  }
                }}
              >
                <Sparkles size={12} aria-hidden="true" /> {t('dlq.action.suggest')}
              </button>
            )}
            {canReplay && (
              <button
                className="small-command we-command-with-kbd"
                disabled={selected.status === 'replayed' || replayingIds.has(selected.id)}
                onClick={() => { void actions.replaySelected() }}
              >
                <span>{t('dlq.action.retry')}</span><kbd aria-hidden="true">R</kbd>
              </button>
            )}
            {canResolve && (
              <button
                className="small-command we-command-with-kbd"
                disabled={selected.status === 'resolved' || replayingIds.has(selected.id)}
                onClick={() => { void actions.resolveSelected() }}
              >
                <span>{t('dlq.action.resolve')}</span><kbd aria-hidden="true">⌘/Ctrl ↵</kbd>
              </button>
            )}
            <button
              type="button"
              className="small-command"
              onClick={() => { void actions.copySelectedError() }}
              data-testid="dlq-copy-error"
            >
              <Copy size={12} aria-hidden="true" /> {t('dlq.action.copyError')}
            </button>
            {canStartRuns && (
              <button
                className="small-command"
                onClick={() => actions.openReplayLab(selected.runId)}
                data-testid="dlq-replay-in-lab"
              >
                <FlaskConical size={12} aria-hidden="true" /> {t('dlq.action.replayInLab')}
              </button>
            )}
            <button
              className="small-command"
              onClick={() => { void actions.exportRunExplain() }}
              data-testid="dlq-export-run-explain"
              aria-label={t('dlq.action.exportAria', { runId: selected.runId })}
            >
              <Download size={12} aria-hidden="true" /> {t('dlq.action.export')}
            </button>
          </div>

          {selectedFull?.drill && (
            <>
              <div className="we-recovery-drill-context" data-testid="dlq-recovery-drill-context">
                <span className="we-pill" data-tone="info">{t('dlq.drill.label')}</span>
                <span className="we-pill" data-tone="neutral">
                  {t(`packs.drill.path.${selectedFull.drill.recoveryPath}`, {
                    defaultValue: selectedFull.drill.recoveryPath,
                  })}
                </span>
              </div>
              {selectedFull.drillOutcome && (
                <RecoveryDrillOutcomeCard outcome={selectedFull.drillOutcome} />
              )}
            </>
          )}

          {selectedFull?.suspectVersion && (
            <div className="we-suspect-version" data-testid="dlq-suspect-version">
              <div className="split-row">
                <span className="we-suspect-version__chip">
                  <GitCompare size={12} aria-hidden="true" />
                  {t('dlq.suspectVersion.chip', {
                    version: selectedFull.suspectVersion.version,
                    time: new Date(selectedFull.suspectVersion.savedAt).toLocaleString(getResolvedLocale()),
                  })}
                </span>
                <button
                  type="button"
                  className="small-command"
                  onClick={actions.toggleSuspectDiff}
                  data-testid="dlq-suspect-version-toggle"
                >
                  {showSuspectDiff ? t('dlq.suspectVersion.hideDiff') : t('dlq.suspectVersion.viewDiff')}
                </button>
              </div>
              {showSuspectDiff && (
                <WorkflowDiffView
                  before={selectedFull.suspectVersion.previousDagJson}
                  after={selectedFull.suspectVersion.dagJson}
                  beforeLabel={t('dlq.suspectVersion.versionLabel', { version: selectedFull.suspectVersion.previousVersion })}
                  afterLabel={t('dlq.suspectVersion.versionLabel', { version: selectedFull.suspectVersion.version })}
                />
              )}
            </div>
          )}

          <DetailBlock title={t('dlq.detail.error')} value={(selectedFull ?? selected).errorJson} />
          <DetailBlock title={t('dlq.detail.node')} value={(selectedFull ?? selected).nodeJson ?? null} />
          <DetailBlock title={t('dlq.detail.workflow')} value={(selectedFull ?? selected).workflowJson ?? null} />
        </section>
      )}
    </>
  )
}

function DetailBlock({ title, value }: { title: string; value: unknown }) {
  const { t } = useT()
  const errorTitle = t('dlq.detail.error')
  const [open, setOpen] = useState(title === errorTitle)

  return (
    <div className="detail-block">
      <button className="small-command" onClick={() => setOpen(!open)}>
        {open ? t('dlq.detail.hide', { title }) : t('dlq.detail.show', { title })}
      </button>
      {open && <pre className="mini-pre">{JSON.stringify(value ?? {}, null, 2)}</pre>}
    </div>
  )
}
