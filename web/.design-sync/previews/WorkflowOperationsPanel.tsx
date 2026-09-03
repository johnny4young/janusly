import { WorkflowOperationsPanel } from '@janusly/web'

/**
 * The operations surface for the selected workflow — a set of controls that
 * stay collapsed until opened, so a closed control loads no data and adds no
 * noise.
 *
 * `readOnly` is the only prop, and it does **not** change this collapsed view:
 * the permission gate applies inside each control once expanded. Both states
 * therefore render identically here, so only one cell is shown rather than a
 * misleading pair.
 */

/** The panel as it opens — every control collapsed. */
export function Collapsed() {
  return <WorkflowOperationsPanel readOnly={false} />
}
