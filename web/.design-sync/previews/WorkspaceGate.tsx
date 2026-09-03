import { WorkspaceGate } from '@janusly/web'
import { sessionNeedsOrganization, sessionSelectionRequired } from './_fixtures'

/**
 * Stands between sign-in and the workspace: it settles which organization the
 * session acts in, and holds until that is decided.
 *
 * `context` is the whole input, and two of its flags drive the copy
 * independently. `selectionRequired` switches the heading to "choose a
 * workspace" and only makes sense with more than one organization in the list;
 * `needsOrganization` means there is nothing to choose from yet, so the create
 * form is the only way forward. A context that sets both reads as a
 * contradiction — an empty list under a "you belong to more than one" line.
 */

/** Two organizations, neither picked yet. */
export function ChooseWorkspace() {
  return <WorkspaceGate context={sessionSelectionRequired} />
}

/** Signed in with no organization at all — create one, or accept an invitation. */
export function NeedsOrganization() {
  return <WorkspaceGate context={sessionNeedsOrganization} />
}
