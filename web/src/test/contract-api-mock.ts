import { MalformedResponseError } from '../lib/malformed-response'

type ContractOptions = RequestInit & { guard?: (value: unknown) => boolean }
type Complete = Partial<Record<string, (payload: never) => unknown>>

/**
 * A `contractApi` over a mocked `api` that still runs the guard; `complete`
 * fills a test's partial payload to the manifest shape before the guard sees it.
 */
export function contractApiOver(api: (path: string, init?: RequestInit) => Promise<unknown>, complete: Complete = {}) {
  return async (operation: string, path: string, request: unknown, { guard, ...init }: ContractOptions = {}) => {
    const method = operation.slice(0, operation.indexOf(' '))
    const raw = await api(path, {
      ...init,
      ...(method === 'GET' ? {} : { method }),
      ...(request === undefined ? {} : { body: JSON.stringify(request) }),
    })
    const fill = complete[operation]
    const payload = fill && raw !== null && typeof raw === 'object' ? fill(raw as never) : raw
    if (guard && !guard(payload)) throw new MalformedResponseError()
    return payload
  }
}
