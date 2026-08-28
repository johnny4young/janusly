import { WorkspaceSectionNav } from '@janusly/web'

/**
 * The workspace section rail. Entries are filtered through `canOpenTab`, so
 * the rail an operator sees is exactly what their permissions allow.
 *
 * Permission strings are **dot-separated** (`workflows.read`, `runs.read`,
 * `recovery.read`, …) — the colon form matches nothing and silently yields an
 * empty rail.
 *
 * Two shapes are worth knowing: `activeTab="home"` renders nothing (Home is
 * its own destination with no rail), and a destination whose visible sections
 * collapse to one — Activity, whose only other section is `hidden` — renders
 * the header alone, since there is nothing to switch between.
 */

const fullAccess = [
  'recovery.read',
  'workflows.read',
  'runs.read',
  'members.read',
  'credentials.read',
  'packs.read',
  'evals.read',
  'ai.write',
]

/** Settings with full permissions — the widest rail, Team active. */
export function SettingsFullAccess() {
  return <WorkspaceSectionNav activeTab="members" permissions={fullAccess} onOpenTab={() => {}} />
}

/** No `permissions` supplied — every section is offered, unfiltered. */
export function Unfiltered() {
  return <WorkspaceSectionNav activeTab="members" onOpenTab={() => {}} />
}

/** A read-only operator on Settings: the rail narrows to what they can open. */
export function NarrowedByPermissions() {
  return (
    <WorkspaceSectionNav
      activeTab="members"
      permissions={['members.read']}
      onOpenTab={() => {}}
    />
  )
}

/** Activity — one visible section, so the rail shows its header alone. */
export function SingleSectionDestination() {
  return <WorkspaceSectionNav activeTab="runs" permissions={fullAccess} onOpenTab={() => {}} />
}
