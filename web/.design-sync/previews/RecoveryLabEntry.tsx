import { RecoveryLabEntry } from '@janusly/web'

/**
 * The Recovery Center's way in for operators with nothing broken yet: it
 * offers the Studio, the recipe catalog, and an optional practice drill.
 * Which affordances appear is decided by which callbacks are supplied.
 */

/** Every route offered, including the practice drill and a dismiss. */
export function FullEntry() {
  return (
    <RecoveryLabEntry
      onOpenStudio={() => {}}
      onOpenRecipes={() => {}}
      onStartDrill={() => {}}
      onDismiss={() => {}}
    />
  )
}

/** No drill available — only the two navigation routes. */
export function WithoutDrill() {
  return <RecoveryLabEntry onOpenStudio={() => {}} onOpenRecipes={() => {}} />
}

/** Drill offered, but the card cannot be dismissed. */
export function NotDismissable() {
  return (
    <RecoveryLabEntry onOpenStudio={() => {}} onOpenRecipes={() => {}} onStartDrill={() => {}} />
  )
}
