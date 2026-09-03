import { PermissionGrantsPanel } from '@janusly/web'

/**
 * The permission-grant surface. `canWrite` reflects whether the current
 * operator may change grants — the panel is readable either way, which is
 * deliberate: seeing who has what is not itself a privileged action.
 */

/** An operator who can edit grants. */
export function Editable() {
  return <PermissionGrantsPanel canWrite />
}

/** A viewer — grants are visible, editing affordances are withheld. */
export function ReadOnly() {
  return <PermissionGrantsPanel canWrite={false} />
}
