import { LocaleSwitcher } from '@janusly/web'

/**
 * Language control, in the two places Janusly mounts it. `auth-corner` floats
 * inside the Login auth card; `popover-row` is a full-width row inside the
 * UserMenu popover. The variant is purely presentational — both drive the
 * same locale runtime.
 */

/** The Login card corner placement. */
export function AuthCorner() {
  return <LocaleSwitcher variant="auth-corner" />
}

/** The UserMenu popover row placement. */
export function PopoverRow() {
  return (
    <div style={{ maxWidth: 280 }}>
      <LocaleSwitcher variant="popover-row" />
    </div>
  )
}
