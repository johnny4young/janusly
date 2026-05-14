/**
 * Supabase login / signup form. Shown only when `isSupabaseConfigured` is
 * true (production-style auth). Dev-headers mode bypasses this entirely.
 *
 * Used by `App.tsx` (mounted as the gate when no session exists).
 */

import React, { useState } from 'react'
import { Building2, LogIn, UserPlus } from 'lucide-react'
import { AuthProvider } from '../auth'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'

type LoginMode = 'login' | 'signup'

/** Email + password form with login/signup toggle; calls `onAuthenticated` on success. */
export function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<LoginMode>('login')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [ssoOrgId, setSsoOrgId] = useState('')

  const startSso = (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = ssoOrgId.trim()
    if (!trimmed) {
      setError('Org id is required for SSO login')
      return
    }
    // Leave the SPA — the API issues a 302 to WorkOS, and the callback
    // brings us back to /auth/sso/complete with the session token in
    // the URL fragment.
    window.location.href = `${API_URL}/auth/sso/start?orgId=${encodeURIComponent(trimmed)}`
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setPending(true)
    try {
      const fn = mode === 'login' ? AuthProvider.signIn : AuthProvider.signUp
      const { error: authError } = await fn(email, password)
      if (authError) {
        setError(authError.message)
        return
      }
      onAuthenticated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-lockup">
          <span className="brand-mark">JN</span>
          <div>
            <strong>Janusly</strong>
            <span>Secure your control plane</span>
          </div>
        </div>

        <h2>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>

        <label className="field-label" htmlFor="auth-email">Email</label>
        <input
          id="auth-email"
          className="text-field"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        <label className="field-label" htmlFor="auth-password">Password</label>
        <input
          id="auth-password"
          className="text-field"
          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          required
          minLength={6}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        {error && <div className="issue issue-error" role="alert">{error}</div>}

        <button type="submit" className="command-button command-button-primary auth-submit" disabled={pending}>
          {mode === 'login' ? <LogIn size={16} aria-hidden="true" /> : <UserPlus size={16} aria-hidden="true" />}
          <span>{pending ? 'Working…' : mode === 'login' ? 'Login' : 'Sign up'}</span>
        </button>

        <button
          type="button"
          className="auth-toggle"
          onClick={() => {
            setMode(mode === 'login' ? 'signup' : 'login')
            setError(null)
          }}
        >
          {mode === 'login' ? 'Need an account? Sign up' : 'Already a member? Log in'}
        </button>

        <div className="auth-divider" role="separator" aria-label="or">
          <span>or</span>
        </div>

        <label className="field-label" htmlFor="auth-sso-org">Org id (for SSO)</label>
        <input
          id="auth-sso-org"
          className="text-field"
          type="text"
          autoComplete="organization"
          placeholder="e.g. acme"
          value={ssoOrgId}
          onChange={(event) => setSsoOrgId(event.target.value)}
        />

        <button
          type="button"
          className="command-button command-button-secondary auth-submit"
          onClick={startSso}
        >
          <Building2 size={16} aria-hidden="true" />
          <span>Continue with SSO</span>
        </button>
      </form>
    </div>
  )
}
