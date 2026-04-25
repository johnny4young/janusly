const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'
const authHeaders = { 'x-org-id': 'org_1', 'x-user-id': 'user_1' }

export async function api(path: string, options: RequestInit = {}) {
  const headers = { 'Content-Type': 'application/json', ...authHeaders, ...(options.headers ?? {}) }
  const res = await fetch(`${API_URL}${path}`, { ...options, headers })
  return res.json()
}
