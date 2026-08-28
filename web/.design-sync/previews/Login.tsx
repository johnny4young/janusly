import { Login } from '@janusly/web'

/**
 * The unauthenticated entry screen — brand lockup, auth card, and the locale
 * switcher in the card corner. `onAuthenticated` is the only input; which
 * sign-in methods appear is decided by the build's auth configuration, not by
 * props.
 */

/** The screen as an unauthenticated visitor first sees it. */
export function Default() {
  return <Login onAuthenticated={() => {}} />
}
