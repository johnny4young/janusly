/** Provider-neutral identity and organization bootstrap contract. */

export type SessionOrganization = {
  id: string
  name: string
  plan: string | null
  role: string
  roleBase: 'viewer' | 'editor' | 'admin' | null
  permissions: string[]
  usable: boolean
  developmentFallback: boolean
}

export type SessionContext = {
  identity: {
    userId: string
    email: string | null
    mode: 'supabase' | 'dev-headers' | 'service-token' | 'janusly-session'
    source: 'web' | 'mcp' | 'service' | 'dev' | 'sso'
  }
  profile: {
    name: string | null
    email: string | null
  }
  organizations: SessionOrganization[]
  invitations: Array<{
    id: string
    organizationId: string
    organizationName: string
    role: string
  }>
  currentOrganizationId: string | null
  selectionRequired: boolean
  needsOrganization: boolean
  truncated: boolean
  invitationsTruncated: boolean
}

export function currentSessionOrganization(context: SessionContext | null): SessionOrganization | null {
  if (!context?.currentOrganizationId) return null
  return context.organizations.find((organization) => organization.id === context.currentOrganizationId) ?? null
}

/** Frontend permission checks are UX only; the API remains authoritative. */
export function sessionCan(context: SessionContext | null, permission: string): boolean {
  return currentSessionOrganization(context)?.permissions.includes(permission) ?? false
}
