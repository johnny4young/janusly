import { WorkflowsDashboardView, useT } from '@janusly/web'

/**
 * The Workflows screen. It is the presentational half of a
 * controller/view pair: `WorkflowsDashboard` owns the state and hands this
 * component one `model` object holding every value and callback.
 *
 * That split is the thing to understand before designing with it. There are no
 * individual props to reach for — a change here means adding a field to the
 * controller. In exchange the whole screen is renderable from plain data, which
 * is exactly what this preview does.
 *
 * Folders are the organising idea: `groups` is an ordered list of
 * `{ key, items }`, and the empty-string key is the ungrouped bucket rather
 * than a folder named "". Selection, tag filters and the trash view are all
 * flags on the same model.
 */

const workflows = [
  { id: 'wf_invoice_recon', orgId: 'org_acme', name: 'Invoice reconciliation', lastRunStatus: 'failed', runCount: 1284, folder: 'Billing', tags: ['finance', 'nightly'], updatedAt: '2026-08-26T02:00:00.000Z' },
  { id: 'wf_dunning', orgId: 'org_acme', name: 'Dunning follow-up', lastRunStatus: 'succeeded', runCount: 412, folder: 'Billing', tags: ['finance'], updatedAt: '2026-08-25T14:20:00.000Z' },
  { id: 'wf_refund_audit', orgId: 'org_acme', name: 'Refund audit', lastRunStatus: 'failed', runCount: 96, folder: 'Billing', tags: ['finance', 'audit'], updatedAt: '2026-08-24T09:05:00.000Z' },
  { id: 'wf_route_planner', orgId: 'org_acme', name: 'Route planner', lastRunStatus: 'succeeded', runCount: 3120, folder: null, tags: ['logistics'], updatedAt: '2026-08-27T00:00:00.000Z' },
  { id: 'wf_onboard_vendor', orgId: 'org_acme', name: 'Vendor onboarding', lastRunStatus: 'paused', runCount: 18, folder: null, tags: [], updatedAt: '2026-08-19T11:42:00.000Z' },
]

const noop = () => {}
const asyncNoop = async () => {}

/** Every callback the view can fire, as no-ops. Data fields follow. */
const callbacks = {
  bulkAssign: asyncNoop,
  bulkAssignTag: asyncNoop,
  bulkRestore: asyncNoop,
  cancelNewFolder: noop,
  clearAllFilters: noop,
  commitNewFolder: noop,
  deleteFolder: asyncNoop,
  deleteTag: asyncNoop,
  deleteWorkflow: asyncNoop,
  load: asyncNoop,
  loadMore: asyncNoop,
  moveToFolder: asyncNoop,
  onCreate: noop,
  onOpen: noop,
  persistCollapsedFolders: noop,
  rememberFolderToggle: noop,
  renameFolder: asyncNoop,
  renameTag: asyncNoop,
  restoreWorkflow: asyncNoop,
  resumeWorkflow: asyncNoop,
  setBulkFolderDraft: noop,
  setBulkTagDraft: noop,
  setConfirmDeleteFolder: noop,
  setConfirmDeleteId: noop,
  setConfirmDeleteTag: noop,
  setCreationOpen: noop,
  setDraggingId: noop,
  setDropTarget: noop,
  setFolderFilter: noop,
  setNewFolderDraft: noop,
  setNewFolderDropFor: noop,
  setNewFolderHover: noop,
  setQuery: noop,
  setRenameDraft: noop,
  setRenamingFolder: noop,
  setRenamingTag: noop,
  setRowTag: asyncNoop,
  setSelectedIds: noop,
  setSelectionMode: noop,
  setShowTrashed: noop,
  setSort: noop,
  setTagFilters: noop,
  setTagRenameDraft: noop,
  toggleFolder: noop,
  toggleSelectAll: noop,
  toggleSelectFolder: noop,
  toggleSelected: noop,
  toggleTrashView: noop,
}

const base = {
  ...callbacks,
  allVisibleSelected: false,
  bulkFolderDraft: '',
  bulkTagDraft: '',
  canWrite: true,
  collapsedFolders: [],
  confirmDeleteFolder: null,
  confirmDeleteId: null,
  confirmDeleteTag: false,
  creationOpen: false,
  draggingId: null,
  dropTarget: null,
  folderFilter: '',
  folderOptions: ['Billing'],
  groups: [
    { key: 'Billing', items: workflows.slice(0, 3) },
    { key: '', items: workflows.slice(3) },
  ],
  hasActiveFilters: false,
  hasFolders: true,
  hasMore: false,
  loadError: null,
  loading: false,
  loadingMore: false,
  newFolderDraft: '',
  newFolderDropFor: null,
  newFolderHover: false,
  query: '',
  recoveryBusyIds: new Set<string>(),
  renameDraft: '',
  renamingFolder: null,
  renamingTag: false,
  selectedIds: new Set<string>(),
  selectionMode: false,
  showToolbar: false,
  showTrashed: false,
  soleTagFilter: undefined,
  sort: 'recent' as const,
  tagFilters: [],
  tagOptions: ['audit', 'finance', 'logistics', 'nightly'],
  tagRenameDraft: '',
  trashNowMs: null,
  retentionDays: 30,
  visible: workflows,
  visibleIds: workflows.map((workflow) => workflow.id),
  workflows,
}

/** A populated workspace: one folder plus the ungrouped bucket. */
export function Populated() {
  const { t } = useT()
  return <WorkflowsDashboardView model={{ ...base, t }} />
}

/** Bulk selection: two workflows picked, the toolbar showing. */
export function SelectionMode() {
  const { t } = useT()
  return (
    <WorkflowsDashboardView
      model={{
        ...base,
        t,
        selectionMode: true,
        showToolbar: true,
        selectedIds: new Set(['wf_invoice_recon', 'wf_refund_audit']),
      }}
    />
  )
}

/** A brand-new workspace, before the first workflow exists. */
export function Empty() {
  const { t } = useT()
  return (
    <WorkflowsDashboardView
      model={{
        ...base,
        t,
        groups: [],
        folderOptions: [],
        hasFolders: false,
        tagOptions: [],
        visible: [],
        visibleIds: [],
        workflows: [],
      }}
    />
  )
}
