/** The consent a person gives before an MCP client connects with OAuth (`/oauth/requests`). */
import { api } from '../api'

export type OAuthCapability = { capability: string; grantable: boolean; missingPermissions: string[] }

export type OAuthConsentRequest = {
  id: string
  clientName: string
  redirectHost: string
  redirectIsLocal: boolean
  organizationId: string
  capabilities: OAuthCapability[]
  maxExpiresInDays: number
  defaultExpiresInDays: number
}

const isText = (value: unknown): value is string => typeof value === 'string'

function isCapability(value: unknown): value is OAuthCapability {
  const item = value as Partial<OAuthCapability> | null
  return !!item && isText(item.capability) && typeof item.grantable === 'boolean' &&
    Array.isArray(item.missingPermissions) && item.missingPermissions.every(isText)
}

function isRequest(value: unknown): value is OAuthConsentRequest {
  const item = value as Partial<OAuthConsentRequest> | null
  return !!item && isText(item.id) && isText(item.clientName) && isText(item.redirectHost) &&
    typeof item.redirectIsLocal === 'boolean' && isText(item.organizationId) &&
    Array.isArray(item.capabilities) && item.capabilities.every(isCapability) &&
    typeof item.maxExpiresInDays === 'number' && typeof item.defaultExpiresInDays === 'number'
}

/** The request id the authorization server put in the URL, if any. */
export function pendingOAuthRequestId(): string | null {
  const id = new URLSearchParams(window.location.search).get('oauth_request')
  return id && /^[0-9a-f-]{36}$/.test(id) ? id : null
}

export async function getOAuthConsentRequest(id: string): Promise<OAuthConsentRequest> {
  const body = await api(`/oauth/requests/${encodeURIComponent(id)}`)
  if (!isRequest(body)) throw new Error('unexpected consent request')
  return body
}

/** Records the decision and returns where the browser must go next. */
export async function decideOAuthConsent(id: string, decision: {
  approve: boolean
  capabilities?: string[]
  expiresInDays?: number
}): Promise<string> {
  const body = await api(`/oauth/requests/${encodeURIComponent(id)}/decision`, { method: 'POST', body: JSON.stringify(decision) })
  const redirectTo = (body as { redirectTo?: unknown } | null)?.redirectTo
  if (!isText(redirectTo)) throw new Error('unexpected consent decision')
  return redirectTo
}
