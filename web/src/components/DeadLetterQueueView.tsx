/**
 * Presentational recovery-queue surface. Data loading, mutation effects, focus
 * recovery, and dialogs remain in DeadLettersPanel; this component renders the
 * operator controls, virtualized rows, and selected-failure details.
 */

import type { KeyboardEventHandler, RefObject } from 'react'
import { CircleCheck, Inbox, RefreshCw, TimerReset, X } from 'lucide-react'

import { formatStatusLabel } from '../constants'
import {
  SEVERITIES,
  SORT_KEYS,
  SORT_KEY_LABELS,
  STATUS_FILTER_KEYS,
  statuses,
  toSeverityFilter,
  toSortKey,
  toStatusFilter,
  type RecoveryQueueFilters,
} from '../hooks/useRecoveryQueueFilters'
import type { UseVirtualListResult } from '../hooks/useVirtualList'
import { getResolvedLocale, useT } from '../i18n'
import { downtimeSeverity, humanizeAge } from './recovery-center/recovery-center-model'
import { BULK_ERROR_PREVIEW, deadLetterRowTone } from './dead-letter-model'
import type { BulkDeadLetterError, DeadLetter } from './dead-letter-types'
import { DeadLetterDetail } from './DeadLetterDetail'
import { EmptyState } from './EmptyState'
import { LoadingSkeleton } from './LoadingSkeleton'
import { RecoveryItemBadge } from './RecoveryItemBadge'
import { RecoveryItemDrawer } from './RecoveryItemDrawer'
import { FieldLabel, SelectControl, TextInput } from '@/components/ui/Form'

type QueueSelectionState = {
  selectionMode: boolean
  selectedIds: ReadonlySet<string>
  selected: DeadLetter | null
  selectedFull: DeadLetter | null
  selectedDetailReady: boolean
  requestedNotFound: boolean
  replayingIds: ReadonlySet<string>
  openRecoveryItem: RecoveryQueueFilters['recoveryItems'][number] | null
  confirmBulkReplay: boolean
  confirmBulkResolve: boolean
  bulkErrors: BulkDeadLetterError[]
  loadedIds: string[]
  allLoadedSelected: boolean
  showSuspectDiff: boolean
}

type QueuePermissions = {
  canReplay: boolean
  canResolve: boolean
  canStartRuns: boolean
  canUseRecovery: boolean
}

type QueueActions = {
  handleKeyDown: KeyboardEventHandler<HTMLElement>
  toggleSelectionMode: () => void
  refresh: () => void
  toggleSelectAll: () => void
  toggleSelect: (id: string) => void
  setConfirmBulkReplay: (value: boolean) => void
  setConfirmBulkResolve: (value: boolean) => void
  bulkReplay: () => Promise<void>
  bulkResolve: () => Promise<void>
  createReplayCampaign: (ids: string[]) => void
  selectRow: (id: string) => void
  openRecoveryItem: (id: string | null) => void
  loadMore: () => void
  startRecovery: (item: DeadLetter) => void
  replaySelected: () => Promise<void>
  resolveSelected: () => Promise<void>
  copySelectedError: () => Promise<void>
  openReplayLab: (runId: string) => void
  exportRunExplain: () => Promise<void>
  toggleSuspectDiff: () => void
}

export type DeadLetterQueueViewProps = {
  queue: RecoveryQueueFilters
  sectionRef: RefObject<HTMLElement | null>
  rowRefs: RefObject<Map<string, HTMLLIElement>>
  cardSeverity: 'warning' | undefined
  virtual: Pick<UseVirtualListResult<DeadLetter>, 'containerRef' | 'visibleItems' | 'totalHeight' | 'startOffset'>
  selection: QueueSelectionState
  permissions: QueuePermissions
  actions: QueueActions
}

export function DeadLetterQueueView({
  queue,
  sectionRef,
  rowRefs,
  cardSeverity,
  virtual,
  selection,
  permissions,
  actions,
}: DeadLetterQueueViewProps) {
  const { t } = useT()
  const {
    status,
    dayFilter,
    ownerScope,
    severityFilter,
    sortKey,
    searchInput,
    filtered,
    recoveryFilterLoading,
    recoveryByDeadLetterId,
    hasMore,
    loadingMore,
    counts,
  } = queue
  const {
    selectionMode,
    selectedIds,
    selected,
    selectedFull,
    selectedDetailReady,
    requestedNotFound,
    replayingIds,
    openRecoveryItem,
    confirmBulkReplay,
    confirmBulkResolve,
    bulkErrors,
    loadedIds,
    allLoadedSelected,
    showSuspectDiff,
  } = selection
  const { canReplay, canResolve, canStartRuns, canUseRecovery } = permissions

  return (
      <section
        ref={sectionRef}
        className="we-card"
        data-severity={cardSeverity}
        data-testid="recovery-queue"
        tabIndex={-1}
        aria-labelledby="recovery-queue-heading"
        aria-keyshortcuts={[
          'J',
          'K',
          canReplay ? 'R' : null,
          canResolve ? 'Meta+Enter Control+Enter' : null,
        ].filter(Boolean).join(' ')}
        onKeyDown={actions.handleKeyDown}
      >
      <div className="split-row">
        <div>
          <div className="section-kicker">{t('dlq.kicker')}</div>
          <strong id="recovery-queue-heading">{t('dlq.queue')}</strong>
        </div>
        <div className="split-row">
          {(canReplay || canResolve) && (
            <button
              type="button"
              className="small-command"
              aria-pressed={selectionMode}
              onClick={actions.toggleSelectionMode}
              data-testid="dlq-select-toggle"
            >
              {selectionMode ? t('dlq.selectDone') : t('dlq.selectRows')}
            </button>
          )}
          <button className="small-command" onClick={actions.refresh}>{t('dlq.refresh')}</button>
        </div>
      </div>

      {/* Org-wide queue-health summary from /dlq/counts — NOT the filtered /
          paginated page, so the breakdown stays honest under any filter. */}
      <div className="mini-grid">
        <span><strong>{counts.total}</strong>{t('dlq.statTotal')}</span>
        <span><strong>{counts.open}</strong>{t('dlq.statOpen')}</span>
        <span><strong>{counts.replayed}</strong>{t('dlq.statRetried')}</span>
        <span><strong>{counts.resolved}</strong>{t('dlq.statResolved')}</span>
      </div>

      {dayFilter && (
        <div className="we-dlq-day-chip" data-testid="dlq-day-filter-chip">
          <span>{t('dlq.dayFilter.label', { day: dayFilter })}</span>
          <button
            type="button"
            className="we-dlq-day-chip__clear"
            onClick={queue.clearDayFilter}
            aria-label={t('dlq.dayFilter.clear')}
            data-testid="dlq-day-filter-clear"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}

      <FieldLabel  htmlFor="dlq-search">{t('dlq.search.label')}</FieldLabel>
      <TextInput
        id="dlq-search"
        type="search"

        value={searchInput}
        onChange={event => queue.setSearchInput(event.target.value)}
        placeholder={t('dlq.search.placeholder')}
        data-testid="dlq-search"
      />

      <FieldLabel  htmlFor="dlq-filter">{t('dlq.show')}</FieldLabel>
      <SelectControl id="dlq-filter"  value={status} onChange={event => queue.setStatus(toStatusFilter(event.target.value))}>
        {statuses.map(item => <option key={item} value={item}>{t(STATUS_FILTER_KEYS[item])}</option>)}
      </SelectControl>

      <div id="dlq-owner-label" className="ui-field__label"><span>{t('dlq.owner.label')}</span></div>
      <div className="we-seg" role="group" aria-labelledby="dlq-owner-label" aria-label={t('dlq.owner.aria')}>
        <button
          type="button"
          aria-pressed={ownerScope === 'all'}
          onClick={() => queue.setOwnerScope('all')}
          data-testid="dlq-owner-all"
        >
          {t('dlq.owner.all')}
        </button>
        <button
          type="button"
          aria-pressed={ownerScope === 'mine'}
          onClick={() => queue.setOwnerScope('mine')}
          data-testid="dlq-owner-mine"
        >
          {t('dlq.owner.mine')}
        </button>
      </div>

      <FieldLabel  htmlFor="dlq-severity-filter">{t('dlq.severity.label')}</FieldLabel>
      <SelectControl
        id="dlq-severity-filter"

        value={severityFilter}
        onChange={event => queue.setSeverityFilter(toSeverityFilter(event.target.value))}
        data-testid="dlq-severity-filter"
      >
        <option value="all">{t('dlq.severity.all')}</option>
        {SEVERITIES.map(sev => (
          <option key={sev} value={sev}>{t(`recoveryItems.severity.${sev}`)}</option>
        ))}
      </SelectControl>

      <FieldLabel  htmlFor="dlq-sort">{t('dlq.sort.label')}</FieldLabel>
      <SelectControl
        id="dlq-sort"

        value={sortKey}
        onChange={event => queue.setSortKey(toSortKey(event.target.value))}
        data-testid="dlq-sort"
      >
        {SORT_KEYS.map(key => (
          <option key={key} value={key}>{t(SORT_KEY_LABELS[key])}</option>
        ))}
      </SelectControl>

      {/* Bulk-select bar — a Select-all toggle (always, in selection mode) plus
          the count + "Resolve selected" once at least one row is ticked. Reuses
          the Flows-list bulk-bar styling. */}
      {selectionMode && (
        <>
        <div className="we-list-bulk-bar" data-testid="dlq-bulk-bar">
          <button
            type="button"
            className="small-command"
            onClick={actions.toggleSelectAll}
            data-testid="dlq-select-all"
          >
            {allLoadedSelected ? t('dlq.deselectAll') : t('dlq.selectAllCount', { count: loadedIds.length })}
          </button>
          {selectedIds.size > 0 && (
            <>
              <span className="we-list-bulk-bar__divider" aria-hidden="true" />
              <span className="we-list-bulk-bar__count">{t('dlq.bulkSelectedCount', { count: selectedIds.size })}</span>
              {/* Replay (recover) is the primary path; Resolve (accept the loss)
                  is the secondary dismiss. Both act on the same ticked set.
                  Replay re-runs workflows, so it goes through an inline confirm. */}
              {canReplay && (confirmBulkReplay ? (
                <span className="we-list-row__confirm">
                  <span className="we-list-row__confirm-text">
                    {t('dlq.bulkReplayConfirm', { count: selectedIds.size })}
                  </span>
                  <button
                    type="button"
                    className="small-command small-command--primary"
                    onClick={() => { void actions.bulkReplay() }}
                    data-testid="dlq-bulk-replay-confirm"
                  >
                    {t('dlq.bulkReplayConfirmCta')}
                  </button>
                  <button
                    type="button"
                    className="small-command"
                    onClick={() => actions.setConfirmBulkReplay(false)}
                  >
                    {t('common.cancel')}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="small-command small-command--primary"
                  onClick={() => actions.setConfirmBulkReplay(true)}
                  data-testid="dlq-bulk-replay"
                >
                  {t('dlq.bulkReplayCta')}
                </button>
              ))}
              {canReplay && (
                <button
                  type="button"
                  className="small-command"
                  disabled={selectedIds.size < 2}
                  title={selectedIds.size < 2 ? t('replayCampaign.minimumSelection') : undefined}
                  onClick={() => actions.createReplayCampaign([...selectedIds])}
                  data-testid="dlq-create-replay-campaign"
                >
                  <TimerReset size={12} aria-hidden="true" /> {t('replayCampaign.createCta')}
                </button>
              )}
              {/* Resolve dismisses N open failures without recovery, so it
                  earns the same inline confirm as replay. */}
              {canResolve && (confirmBulkResolve ? (
                <span className="we-list-row__confirm">
                  <span className="we-list-row__confirm-text">
                    {t('dlq.bulkResolveConfirm', { count: selectedIds.size })}
                  </span>
                  <button
                    type="button"
                    className="small-command small-command--primary"
                    onClick={() => { void actions.bulkResolve() }}
                    data-testid="dlq-bulk-resolve-confirm"
                  >
                    {t('dlq.bulkResolveConfirmCta')}
                  </button>
                  <button
                    type="button"
                    className="small-command"
                    onClick={() => actions.setConfirmBulkResolve(false)}
                  >
                    {t('common.cancel')}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="small-command"
                  onClick={() => actions.setConfirmBulkResolve(true)}
                  data-testid="dlq-bulk-resolve"
                >
                  {t('dlq.bulkResolveCta')}
                </button>
              ))}
            </>
          )}
        </div>
        {/* Surface WHY rows failed (and which) from the partial-success
            envelope — the count toast alone leaves the operator guessing
            between a transient blip and "already replayed". role="alert" so a
            screen reader announces the failures. Server error strings are
            rendered verbatim (exempt from i18n per the error-message rule). */}
        {bulkErrors.length > 0 && (
          <div className="we-dlq-bulk-errors" role="alert" data-testid="dlq-bulk-errors">
            <span className="we-dlq-bulk-errors__label">
              {t('dlq.bulkErrorsHeading', { count: bulkErrors.length })}
            </span>
            <ul>
              {bulkErrors.slice(0, BULK_ERROR_PREVIEW).map((entry, idx) => (
                // Composite key: the id stays the stable identity, the index
                // disambiguates if the envelope ever carries a duplicate id.
                <li key={`${entry.deadLetterId}-${idx}`}>
                  <code>{entry.deadLetterId}</code> — {entry.error}
                </li>
              ))}
            </ul>
            {bulkErrors.length > BULK_ERROR_PREVIEW && (
              <span className="we-dlq-bulk-errors__more">
                {t('dlq.bulkErrorsMore', { count: bulkErrors.length - BULK_ERROR_PREVIEW })}
              </span>
            )}
          </div>
        )}
        </>
      )}

      <div className="panel-list">
        {recoveryFilterLoading && filtered.length === 0 && (
          <LoadingSkeleton rows={4} label={t('common.loading')} />
        )}
        {filtered.length === 0 && !recoveryFilterLoading && (
          <EmptyState
            icon={<CircleCheck />}
            kicker={t(
              searchInput.trim() !== ''
                ? 'emptyState.dlq.search.kicker'
                : severityFilter !== 'all'
                  ? 'emptyState.dlq.severity.kicker'
                  : ownerScope === 'mine'
                    ? 'emptyState.dlq.mine.kicker'
                    : 'emptyState.dlq.kicker',
            )}
            body={t(
              searchInput.trim() !== ''
                ? 'emptyState.dlq.search.body'
                : severityFilter !== 'all'
                  ? 'emptyState.dlq.severity.body'
                  : ownerScope === 'mine'
                    ? 'emptyState.dlq.mine.body'
                    : 'emptyState.dlq.body',
            )}
            testId={
              searchInput.trim() !== ''
                ? 'dlq-empty-search'
                : severityFilter !== 'all'
                  ? 'dlq-empty-severity'
                  : ownerScope === 'mine'
                    ? 'dlq-empty-mine'
                    : 'dlq-empty'
            }
          />
        )}
        {filtered.length > 0 && (
          <>
          <div ref={virtual.containerRef} className="we-virtual-list we-dlq-virtual-list" data-testid="dlq-virtual-list">
            <div style={{ height: virtual.totalHeight, position: 'relative' }}>
              <ul
                className="we-list"
                style={{ transform: `translateY(${virtual.startOffset}px)` }}
                role="grid"
                aria-labelledby="recovery-queue-heading"
                aria-multiselectable={selectionMode}
                aria-rowcount={filtered.length}
              >
                {virtual.visibleItems.map(({ item, index }) => {
                  const severity = deadLetterRowTone(item.status)
                  const isReplaying = replayingIds.has(item.id)
                  return (
                    <li
                      key={item.id}
                      ref={(node) => {
                        if (node) rowRefs.current.set(item.id, node)
                        else rowRefs.current.delete(item.id)
                      }}
                      className="we-list-row we-dlq-row"
                      role="row"
                      data-clickable="true"
                      data-selection-mode={selectionMode ? 'true' : undefined}
                      data-severity={severity}
                      data-testid={`dlq-row-${item.id}`}
                      data-dead-letter-id={item.id}
                      data-selected={selected?.id === item.id ? 'true' : undefined}
                      tabIndex={selected?.id === item.id ? 0 : -1}
                      aria-label={`${item.nodeId} — ${isReplaying ? t('dlq.recovering') : formatStatusLabel(item.status)}`}
                      aria-selected={selectionMode ? selectedIds.has(item.id) : selected?.id === item.id}
                      aria-rowindex={index + 1}
                      onFocus={() => actions.selectRow(item.id)}
                      onClick={() => (selectionMode ? actions.toggleSelect(item.id) : actions.selectRow(item.id))}
                    >
                        {selectionMode && (
                          <span role="gridcell" className="we-dlq-row__selection-cell">
                            <input
                              type="checkbox"
                              className="we-list-row__select"
                              checked={selectedIds.has(item.id)}
                              disabled={isReplaying}
                              onClick={event => event.stopPropagation()}
                              onChange={event => { event.stopPropagation(); actions.toggleSelect(item.id) }}
                              aria-label={t('dlq.selectRowAria', { node: item.nodeId })}
                              data-testid={`dlq-select-row-${item.id}`}
                            />
                          </span>
                        )}
                        <div className="we-dlq-row__identity" role="gridcell">
                          <span className="we-list-row__avatar" aria-hidden="true"><Inbox size={14} /></span>
                          <div className="we-list-row__body">
                            <strong>{item.nodeId}</strong>
                            <small>
                              {t('dlq.runMeta', { runIdShort: item.runId.slice(0, 8), attempt: item.attempt })}
                              {item.createdAt ? ` · ${new Date(item.createdAt).toLocaleString(getResolvedLocale())}` : ''}
                            </small>
                          </div>
                        </div>
                        <div className="we-list-row__meta" role="gridcell">
                          {item.status === 'open' && item.createdAt && (
                            <span
                              className="we-list-row__downtime"
                              data-severity={downtimeSeverity(item.createdAt, Date.now())}
                              title={t('dlq.downtimeTitle')}
                              data-testid={`dlq-downtime-${item.id}`}
                            >
                              {humanizeAge(item.createdAt, Date.now())}
                            </span>
                          )}
                          <span
                            className={`we-list-row__pill we-list-row__pill--${isReplaying ? 'cyan' : severity}`}
                            data-testid={isReplaying ? `dlq-recovering-${item.id}` : undefined}
                            role="status"
                            aria-live="polite"
                            aria-atomic="true"
                          >
                            {isReplaying && <RefreshCw size={11} className="we-spin" aria-hidden="true" />}
                            {isReplaying ? t('dlq.recovering') : formatStatusLabel(item.status)}
                          </span>
                          <RecoveryItemBadge
                            item={recoveryByDeadLetterId.get(item.id) ?? null}
                            onOpen={() => {
                              const ri = recoveryByDeadLetterId.get(item.id)
                              if (ri) actions.openRecoveryItem(ri.id)
                            }}
                          />
                        </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>
          {/* Sibling BELOW the scroll container — never buried inside the
              virtual list's internal scroll, so it stays reachable. */}
          {hasMore && (
            <button
              type="button"
              className="small-command we-load-more"
              onClick={() => { void actions.loadMore() }}
              disabled={loadingMore}
              data-testid="dlq-load-more"
            >
              {loadingMore ? t('dlq.loadingMore') : t('dlq.loadMore')}
            </button>
          )}
          </>
        )}
        {openRecoveryItem && (
          <RecoveryItemDrawer
            item={openRecoveryItem}
            onClose={() => actions.openRecoveryItem(null)}
          />
        )}
      </div>

      <DeadLetterDetail
        selection={{
          requestedNotFound,
          selectionMode,
          selected,
          selectedFull,
          selectedDetailReady,
          replayingIds,
          showSuspectDiff,
        }}
        permissions={{ canReplay, canResolve, canStartRuns, canUseRecovery }}
        actions={{
          startRecovery: actions.startRecovery,
          replaySelected: actions.replaySelected,
          resolveSelected: actions.resolveSelected,
          copySelectedError: actions.copySelectedError,
          openReplayLab: actions.openReplayLab,
          exportRunExplain: actions.exportRunExplain,
          toggleSuspectDiff: actions.toggleSuspectDiff,
        }}
      />
      </section>
  )
}
