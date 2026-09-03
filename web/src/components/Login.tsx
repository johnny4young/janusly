/**
 * Supabase login / signup form. Shown only when `isSupabaseConfigured` is
 * true (production-style auth). Dev-headers mode bypasses this entirely.
 *
 * Used by `App.tsx` (mounted as the gate when no session exists). Hosts the
 * `<LocaleSwitcher>` in the auth-card corner so a user can pick a language
 * BEFORE signing in.
 */

import React, { useState } from 'react'
import { Building2, LogIn, UserPlus } from 'lucide-react'
import { AuthProvider } from '../auth'
import { LocaleSwitcher } from '../i18n/LocaleSwitcher'
import { useT } from '../i18n'
import { BrandMark } from './BrandMark'
import { Button } from '@/components/ui/Button'
import { FieldLabel, TextInput } from '@/components/ui/Form'

type LoginMode = 'login' | 'signup'

/** Email + password form with login/signup toggle; calls `onAuthenticated` on success. */
export function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const { t } = useT()
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
      setError(t('auth.login.ssoOrgRequired'))
      return
    }
    // Leave the SPA — the API issues a 302 to WorkOS, and the callback
    // returns to /auth/sso/complete after setting the HttpOnly session cookie.
    window.location.href = `/auth/sso/start?orgId=${encodeURIComponent(trimmed)}`
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
      setError(err instanceof Error ? err.message : t('auth.login.authFailed'))
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="auth-screen">
      <LocaleSwitcher variant="auth-corner" />
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-lockup auth-card__brand">
          <BrandMark size={36} />
          <div>
            <strong>{t('app.brand')}</strong>
            <span>{t('app.brandSubtitle')}</span>
          </div>
        </div>

        <h1>{mode === 'login' ? t('auth.login.welcomeBack') : t('auth.login.createAccount')}</h1>

        <FieldLabel  htmlFor="auth-email">{t('auth.login.email')}</FieldLabel>
        <TextInput
          id="auth-email"

          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        <FieldLabel  htmlFor="auth-password">{t('auth.login.password')}</FieldLabel>
        <TextInput
          id="auth-password"

          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          required
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        {error && <div className="issue issue-error" role="alert">{error}</div>}

        <Button variant="primary" type="submit" className="auth-submit" disabled={pending}>
          {mode === 'login' ? <LogIn size={16} aria-hidden="true" /> : <UserPlus size={16} aria-hidden="true" />}
          <span>{pending ? t('common.working') : mode === 'login' ? t('auth.login.login') : t('auth.login.signUp')}</span>
        </Button>

        <button
          type="button"
          className="auth-toggle"
          onClick={() => {
            setMode(mode === 'login' ? 'signup' : 'login')
            setError(null)
          }}
        >
          {mode === 'login' ? t('auth.login.needAccount') : t('auth.login.haveAccount')}
        </button>

        <div className="auth-divider" role="separator" aria-label={t('auth.login.or')}>
          <span>{t('auth.login.or')}</span>
        </div>

        <FieldLabel  htmlFor="auth-sso-org">{t('auth.login.ssoOrgLabel')}</FieldLabel>
        <TextInput
          id="auth-sso-org"

          type="text"
          autoComplete="organization"
          placeholder={t('auth.login.ssoOrgPlaceholder')}
          value={ssoOrgId}
          onChange={(event) => setSsoOrgId(event.target.value)}
        />

        <Button variant="secondary"
          type="button"
          className="auth-submit"
          onClick={startSso}
        >
          <Building2 size={16} aria-hidden="true" />
          <span>{t('auth.login.continueSso')}</span>
        </Button>
      </form>
    </main>
  )
}
