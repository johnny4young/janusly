/**
 * Small HTML drag-and-drop contract shared by the sidebar palette and the
 * lazy React Flow canvas. The payload carries only a registered node type;
 * config still comes from the store's canonical node preset.
 */

export const NODE_PALETTE_DRAG_TYPE = 'application/x-janusly-node-type'

/** Put a node type on a palette drag without replacing the click fallback. */
export function writeNodePaletteDrag(dataTransfer: DataTransfer, nodeType: string): void {
  dataTransfer.effectAllowed = 'copy'
  dataTransfer.setData(NODE_PALETTE_DRAG_TYPE, nodeType)
}

/** Read the bounded palette payload. Unknown values are validated by caller. */
export function readNodePaletteDrag(dataTransfer: DataTransfer): string | null {
  const value = dataTransfer.getData(NODE_PALETTE_DRAG_TYPE).trim()
  return value.length > 0 && value.length <= 64 ? value : null
}

/** True when the active drag advertises Janusly's palette payload. */
export function hasNodePaletteDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(NODE_PALETTE_DRAG_TYPE)
}
