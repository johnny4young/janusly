import { useEffect } from 'react'
import { api } from '../api'
import { AuthProvider } from '../auth'
import type { SessionContext } from '../identity-context'
import type { Translate } from '../i18n/resources'

type AuthSnapshot = Awaited<ReturnType<typeof AuthProvider.getAuth>>

type IdentityBootstrapOptions = {
  authReady: boolean
  userId: string | null
  orgId: string | null
  setAuth: (auth: AuthSnapshot) => void
  clearAuth: () => void
  setAuthReady: (ready: boolean) => void
  setIdentityContext: (context: SessionContext | null) => void
  setIdentityPending: () => void
  addToast: (message: string, tone: 'success' | 'error' | 'info') => void
  t: Translate
}

/**
 * Resolve provider identity first, then load the tenant-scoped session
 * context. The two phases stay separate so an authenticated user with no
 * organization can still reach workspace onboarding.
 */
export function useIdentityBootstrap(options: IdentityBootstrapOptions): void {
  const {
    authReady,
    userId,
    orgId,
    setAuth,
    clearAuth,
    setAuthReady,
    setIdentityContext,
    setIdentityPending,
    addToast,
    t,
  } = options

  useEffect(() => {
    let mounted = true

    void AuthProvider.getAuth().then((auth) => {
      if (mounted) setAuth(auth)
    }).catch(() => {
      if (mounted) clearAuth()
    }).finally(() => {
      if (mounted) setAuthReady(true)
    })

    let unsubscribe: (() => void) | undefined
    void AuthProvider.onAuthStateChange((auth) => {
      if (!mounted) return
      if (!auth.session && !auth.userId) clearAuth()
      else setAuth(auth)
    }).then(({ data: listener }) => {
      if (!mounted) listener.subscription.unsubscribe()
      else unsubscribe = () => listener.subscription.unsubscribe()
    }).catch(() => {
      // The initial session request owns readiness; listener loading is retried
      // naturally on the next page load.
    })

    return () => {
      mounted = false
      unsubscribe?.()
    }
  }, [clearAuth, setAuth, setAuthReady])

  useEffect(() => {
    if (!authReady) return
    if (!userId) {
      setIdentityContext(null)
      return
    }

    let cancelled = false
    setIdentityPending()
    void (async () => {
      try {
        const context = await api('/auth/context') as SessionContext
        if (cancelled) return

        if (context.currentOrganizationId && context.currentOrganizationId !== orgId) {
          const { auth } = await AuthProvider.updateOrg(context.currentOrganizationId)
          if (cancelled) return
          setAuth(auth)
        }
        setIdentityContext(context)
      } catch (error) {
        if (cancelled) return
        setIdentityContext(null)
        addToast(
          error instanceof Error ? error.message : t('auth.context.loadFailed'),
          'error',
        )
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    addToast,
    authReady,
    orgId,
    setAuth,
    setIdentityContext,
    setIdentityPending,
    t,
    userId,
  ])
}
