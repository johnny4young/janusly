/**
 * Demand-loaded Supabase Auth runtime.
 *
 * The web application never reads Supabase tables, storage, functions, or
 * realtime channels. Keeping the focused Auth client behind this boundary
 * avoids shipping those unrelated browser SDK surfaces while preserving the
 * session behavior of `createClient(url, key).auth`.
 */
import { GoTrueClient } from '@supabase/auth-js'

function projectRef(url: URL): string {
  return url.hostname.split('.')[0] || 'local'
}

export function createClient(url: string, key: string): { auth: GoTrueClient } {
  const baseUrl = new URL(url.endsWith('/') ? url : `${url}/`)
  return {
    auth: new GoTrueClient({
      url: new URL('auth/v1', baseUrl).href,
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
      },
      storageKey: `sb-${projectRef(baseUrl)}-auth-token`,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      flowType: 'implicit',
    }),
  }
}
