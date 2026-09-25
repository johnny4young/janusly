import { t } from '../i18n/runtime'

/**
 * A successful response the browser cannot use: it failed its generated guard
 * or a UI invariant. Panels catch it to show their own unavailable state
 * instead of the generic message; transport and HTTP errors are not this.
 */
export class MalformedResponseError extends Error {
  constructor() {
    super(t('api.error.malformedResponse'))
    this.name = 'MalformedResponseError'
  }
}
