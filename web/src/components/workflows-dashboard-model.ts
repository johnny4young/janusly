export const UNGROUPED_FOLDER = ''

export function updateCollapsedFolders(
  current: string[],
  key: string,
  open: boolean,
): string[] {
  const collapsed = current.includes(key)
  if (open && collapsed) return current.filter((entry) => entry !== key)
  if (!open && !collapsed) return [...current, key]
  return current
}
