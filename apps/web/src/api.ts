import { supabase } from './auth'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'

export async function api(path: string, options: RequestInit = {}) {
  const session = await supabase.auth.getSession()
  const token = session.data.session?.access_token

  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers ?? {})
  }

  const res = await fetch(`${API_URL}${path}`, { ...options, headers })
  return res.json()
}
