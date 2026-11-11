import type { FlowRowProps } from '../components/FlowRow'
import type { SavedWorkflow } from '../types'

const noop = () => undefined

export function flowRowProps(workflow: SavedWorkflow, overrides: Partial<FlowRowProps> = {}): FlowRowProps {
  return {
    workflow,
    canWrite: true,
    folderOptions: [],
    tagOptions: [],
    hasFolders: false,
    selectionMode: false,
    selectedIds: new Set(),
    draggingId: null,
    onOpen: noop,
    toggleSelected: noop,
    setDraggingId: noop,
    setDropTarget: noop,
    setRowTag: noop,
    moveToFolder: noop,
    deleteWorkflow: noop,
    resumeWorkflow: noop,
    pauseWorkflow: noop,
    recoveryBusy: false,
    t: ((key: string) => key) as FlowRowProps['t'],
    ...overrides,
  }
}
