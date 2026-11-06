/**
 * Supabase login / signup form. Shown only when `isSupabaseConfigured` is
 * true (production-style auth). Dev-headers mode bypasses this entirely.
 *
 * Used by `App.tsx` (mounted as the gate when no session exists). Hosts the
 * `<LocaleSwitcher>` in the auth-card corner so a user can pick a language
 * BEFORE signing in.
 */

import React, { useEffect, useState } from 'react'
import { Building2, LogIn, UserPlus } from 'lucide-react'
import { AuthProvider } from '../auth'
import { authCallbackFailed, clearAuthCallback } from '../auth-callback'
import { LocaleSwitcher } from '../i18n/LocaleSwitcher'
import { useT } from '../i18n'
import { BrandMark } from './BrandMark'
import { Button } from '@/components/ui/Button'
import { FieldLabel, TextInput } from '@/components/ui/Form'

type LoginMode = 'login' | 'signup' | 'reset'

/** Email + password form with login, signup and reset-link modes; calls `onAuthenticated` on success. */
export function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const { t } = useT()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<LoginMode>('login')
  // A fixed message: the link's own `error_description` is attacker-writable text.
  const [error, setError] = useState<string | null>(() => (authCallbackFailed() ? t('auth.login.callbackFailed') : null))
  const [pending, setPending] = useState(false)
  const [ssoOrgId, setSsoOrgId] = useState('')
  const [resetSent, setResetSent] = useState(false)

  useEffect(() => clearAuthCallback(), [])

  const switchMode = (next: LoginMode) => {
    setMode(next)
    setError(null)
    setResetSent(false)
    // The button that was clicked may be about to unmount.
    document.getElementById('auth-email')?.focus()
  }

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
    setResetSent(false)
    setPending(true)
    try {
      if (mode === 'reset') {
        const { error: resetError } = await AuthProvider.requestPasswordReset(email)
        // Email limits only answer for an existing account, so they must read as a send.
        // The status decides: a gateway that hides the API version header also hides the code.
        if (resetError && (resetError.status !== 429 || resetError.code === 'over_request_rate_limit')) {
          throw resetError
        }
        setResetSent(true)
        return
      }
      const fn = mode === 'login' ? AuthProvider.signIn : AuthProvider.signUp
      const { error: authError } = await fn(email, password)
      if (authError) {
        setError(authError.message)
        return
      }
      onAuthenticated()
    } catch (err) {
      setError(mode === 'reset' ? t('auth.login.resetFailed') : err instanceof Error ? err.message : t('auth.login.authFailed'))
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

        <h1>
          {mode === 'reset'
            ? t('auth.login.forgotPassword')
            : mode === 'login' ? t('auth.login.welcomeBack') : t('auth.login.createAccount')}
        </h1>

        <FieldLabel  htmlFor="auth-email">{t('auth.login.email')}</FieldLabel>
        <TextInput
          id="auth-email"

          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        {mode !== 'reset' && (
          <>
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
          </>
        )}

        {error && <div className="issue issue-error" role="alert">{error}</div>}
        {resetSent && <div className="issue" role="status">{t('auth.login.resetSent')}</div>}

        <Button
          variant="primary"
          type="submit"
          className="auth-submit"
          loading={pending}
          loadingLabel={t('common.working')}
          leadingIcon={mode === 'login' ? <LogIn size={16} /> : mode === 'signup' && <UserPlus size={16} />}
        >
          {mode === 'reset' ? t('auth.login.resetSend') : mode === 'login' ? t('auth.login.login') : t('auth.login.signUp')}
        </Button>

        {mode === 'reset' ? (
          <button type="button" className="auth-toggle" onClick={() => switchMode('login')}>
            {t('common.back')}
          </button>
        ) : (
          <>
            {mode === 'login' && (
              <button type="button" className="auth-toggle" onClick={() => switchMode('reset')}>
                {t('auth.login.forgotPassword')}
              </button>
            )}

            <button
              type="button"
              className="auth-toggle"
              onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}
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
          </>
        )}
      </form>
    </main>
  )
}
