/**
 * Localized fallback for a panel whose render threw.
 *
 * Deliberately offers a retry instead of a page reload: a panel usually trips
 * on one bad payload, so re-rendering after the next poll is enough and the
 * operator keeps the rest of the workspace — including any in-flight run they
 * were watching. Reloading is the canvas's remedy, not a panel's.
 *
 * Used by `RightPanel.tsx` and `App.tsx` through `ErrorBoundary`'s render-prop
 * fallback.
 */

import { AlertTriangle } from 'lucide-react'
import { useT } from '../i18n'
import { Button } from './ui/Button'
import { StatusSummary } from './ui/StatusSummary'

type PanelErrorFallbackProps = {
  /** Clears the boundary so the subtree re-renders in place. */
  onRetry: () => void
}

export function PanelErrorFallback({ onRetry }: PanelErrorFallbackProps) {
  const { t } = useT()
  return (
    <div className="panel-list" role="alert" data-testid="panel-error-fallback">
      <StatusSummary
        icon={<AlertTriangle size={16} />}
        tone="danger"
        title={t('panel.error.title')}
        description={t('panel.error.body')}
        actions={<Button size="sm" onClick={onRetry}>{t('panel.error.retry')}</Button>}
      />
    </div>
  )
}
