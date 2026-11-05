/**
 * Approval screen for a sign-in link. Mounted instead of the app, so no route
 * write, identity bootstrap or API request runs until the user decides.
 */

import { StrictMode, useState } from 'react'
import type { Root } from 'react-dom/client'
import { resolveAuthCallbackIdentity } from '../auth'
import { approveAuthCallback, clearAuthCallback } from '../auth-callback'
import { useT } from '../i18n'
import { BrandMark } from './BrandMark'
import { Button } from '@/components/ui/Button'

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
        <div className="brand-lockup auth-card__brand">
          <BrandMark size={36} />
          <div>
            <strong>{t('app.brand')}</strong>
          </div>
        </div>
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

/** Resolves once the captured callback is approved, declined or found invalid. */
export async function settleAuthCallback(root: Root): Promise<void> {
  const email = await resolveAuthCallbackIdentity()
  if (!email) return
  const approved = await new Promise<boolean>((resolve) => {
    root.render(
      <StrictMode>
        <AuthCallbackConfirm email={email} onDecide={resolve} />
      </StrictMode>,
    )
  })
  if (approved) approveAuthCallback()
  else clearAuthCallback()
}
