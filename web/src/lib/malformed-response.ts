import { t } from '../i18n/runtime'

/** A 2xx payload that failed its generated guard or a UI invariant; panels catch it to show their own copy. */
export class MalformedResponseError extends Error {
  constructor() {
    super(t('api.error.malformedResponse'))
    this.name = 'MalformedResponseError'
  }
}
