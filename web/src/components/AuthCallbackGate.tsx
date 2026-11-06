/**
 * Approval and set-password screens for an emailed link. Mounted instead of the
 * app, so no route write, identity bootstrap or API request runs until they settle.
 */

import { StrictMode, useState, type FormEvent } from 'react'
import type { Root } from 'react-dom/client'
import type { AuthError } from '@supabase/auth-js'
import { AuthProvider, resolveAuthCallbackIdentity, resolvePasswordSetupEmail } from '../auth'
import {
  approveAuthCallback,
  authCallbackFailed,
  authCallbackSetsPassword,
  clearAuthCallback,
  clearPasswordSetup,
  markPasswordSetup,
} from '../auth-callback'
import { useT } from '../i18n'
import { BrandMark } from './BrandMark'
import { Button } from '@/components/ui/Button'
import { FieldLabel, TextInput } from '@/components/ui/Form'

function AuthCardBrand() {
  const { t } = useT()
  return (
    <div className="brand-lockup auth-card__brand">
      <BrandMark size={36} />
      <div>
        <strong>{t('app.brand')}</strong>
      </div>
    </div>
  )
}

function AuthCallbackConfirm({ email, onDecide }: { email: string; onDecide: (approved: boolean) => void }) {
  const { t } = useT()
  const [deciding, setDeciding] = useState(false)
  const decide = (approved: boolean) => {
    setDeciding(true)
    onDecide(approved)
  }

  return (
    <main className="auth-screen">
      <div className="auth-card">
        <AuthCardBrand />
        <h1>{t('auth.login.callbackConfirm', { email })}</h1>
        <Button
          variant="primary"
          className="auth-submit"
          loading={deciding}
          loadingLabel={t('common.working')}
          onClick={() => decide(true)}
        >
          {t('auth.login.callbackContinue')}
        </Button>
        <Button variant="secondary" className="auth-submit" disabled={deciding} onClick={() => decide(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </main>
  )
}

// Codes that retrying with another password cannot fix. Auth statuses are the rest of that class.
const NEEDS_NEW_LINK = new Set([
  'current_password_required',
  'reauthentication_needed',
  'refresh_token_already_used',
  'refresh_token_not_found',
  'session_expired',
  'session_not_found',
])

function passwordErrorKey(error: AuthError) {
  if (error.code === 'weak_password') return 'auth.setPassword.weak'
  if (error.code === 'same_password') return 'auth.setPassword.same'
  if (
    error.name === 'AuthSessionMissingError'
    || error.status === 401
    || error.status === 403
    || (error.code && NEEDS_NEW_LINK.has(error.code))
  ) return 'auth.setPassword.newLink'
  return 'auth.setPassword.failed'
}

function SetPassword({ email, onDone }: { email: string; onDone: () => void }) {
  const { t } = useT()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (password !== confirmation) {
      setError(t('auth.setPassword.mismatch'))
      return
    }
    setError(null)
    setSaving(true)
    try {
      const { error: updateError } = await AuthProvider.updatePassword(password)
      if (!updateError) {
        onDone()
        return
      }
      setError(t(passwordErrorKey(updateError)))
    } catch {
      setError(t('auth.setPassword.failed'))
    }
    setSaving(false)
  }

  const signOut = async () => {
    setError(null)
    setSigningOut(true)
    try {
      const { error: signOutError } = await AuthProvider.signOut()
      if (!signOutError) {
        onDone()
        return
      }
    } catch {
      // Reported below.
    }
    setError(t('toasts.signOutFailed'))
    setSigningOut(false)
  }

  return (
    <main className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <AuthCardBrand />
        <h1>{t('auth.setPassword.title')}</h1>
        <p className="auth-card__account">{email}</p>
        {/* Tells password managers which account the new password belongs to. */}
        <input type="email" autoComplete="username" value={email} readOnly hidden />

        <FieldLabel htmlFor="set-password-new">{t('auth.setPassword.newPassword')}</FieldLabel>
        <TextInput
          id="set-password-new"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        <FieldLabel htmlFor="set-password-confirm">{t('auth.setPassword.confirmPassword')}</FieldLabel>
        <TextInput
          id="set-password-confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />

        {error && <div className="issue issue-error" role="alert">{error}</div>}

        <Button
          variant="primary"
          type="submit"
          className="auth-submit"
          disabled={signingOut}
          loading={saving}
          loadingLabel={t('common.working')}
        >
          {t('auth.setPassword.save')}
        </Button>
        <Button
          variant="secondary"
          className="auth-submit"
          disabled={saving}
          loading={signingOut}
          loadingLabel={t('common.working')}
          onClick={() => void signOut()}
        >
          {t('userMenu.item.signOut')}
        </Button>
      </form>
    </main>
  )
}

/** Resolves once the captured callback is settled and any owed password is set or abandoned. */
export async function settleAuthCallback(root: Root): Promise<void> {
  const identity = await resolveAuthCallbackIdentity()
  if (identity) {
    const approved = await new Promise<boolean>((resolve) => {
      root.render(
        <StrictMode>
          <AuthCallbackConfirm email={identity.email} onDecide={resolve} />
        </StrictMode>,
      )
    })
    if (!approved) {
      clearAuthCallback()
    } else {
      // Marked before adoption, so no moment holds a stored session without the step.
      if (authCallbackSetsPassword()) markPasswordSetup(identity.id)
      approveAuthCallback()
      await AuthProvider.getSession()
      if (authCallbackFailed()) {
        clearPasswordSetup()
        return
      }
    }
  }

  const email = await resolvePasswordSetupEmail()
  if (!email) return
  await new Promise<void>((resolve) => {
    root.render(
      <StrictMode>
        <SetPassword email={email} onDone={resolve} />
      </StrictMode>,
    )
  })
}
