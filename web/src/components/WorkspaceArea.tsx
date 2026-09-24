/**
 * Local loading/error boundary for a workspace main or panel slot.
 *
 * The shared shell uses the eager core catalog, so it stays interactive while
 * the workspace namespace or a lazy panel chunk arrives. A rejected chunk or
 * render error is contained to the owning slot and can be retried in place.
 */

import { Suspense, type ReactNode } from 'react'
import { I18nNamespaceGate, useT } from '../i18n'
import { ErrorBoundary } from './ErrorBoundary'
import { LoadingSkeleton } from './LoadingSkeleton'
import { PanelErrorFallback } from './PanelErrorFallback'

export function WorkspaceAreaLoading() {
  const { t } = useT()
  return (
    <div className="workspace-area-loading">
      <LoadingSkeleton
        rows={4}
        label={t('common.working')}
        testId="workspace-content-loading"
      />
    </div>
  )
}

export function WorkspaceArea({
  children,
  resetKey,
  logTag,
}: {
  children: ReactNode
  resetKey: string
  logTag: string
}) {
  return (
    <ErrorBoundary
      resetKey={resetKey}
      logTag={logTag}
      fallback={({ reset }) => <PanelErrorFallback onRetry={reset} />}
    >
      <Suspense fallback={<WorkspaceAreaLoading />}>
        <I18nNamespaceGate namespace="workspace">
          {children}
        </I18nNamespaceGate>
      </Suspense>
    </ErrorBoundary>
  )
}
