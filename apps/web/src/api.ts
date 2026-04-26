import { supabase } from './auth'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'

export async function api(path: string, options: RequestInit = {}) {
  const session = supabase ? await supabase.auth.getSession() : { data: { session: null } }
  const token = session.data.session?.access_token

  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(!token ? { 'x-org-id': 'default', 'x-user-id': 'dev-user' } : {}),
    ...(options.headers ?? {})
  }

  const res = await fetch(`${API_URL}${path}`, { ...options, headers })
  const payload = await res.json().catch(() => ({}))

  if (!res.ok) {
    const message = typeof payload?.error === 'string' ? payload.error : `Request failed with ${res.status}`
    throw new Error(message)
  }

  return payload
}
