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

import { useT } from '../i18n'

type PanelErrorFallbackProps = {
  /** Clears the boundary so the subtree re-renders in place. */
  onRetry: () => void
}

export function PanelErrorFallback({ onRetry }: PanelErrorFallbackProps) {
  const { t } = useT()
  return (
    <div className="panel-list" role="alert" data-testid="panel-error-fallback">
      <div className="we-card">
        <strong>{t('panel.error.title')}</strong>
        <p className="helper-text">{t('panel.error.body')}</p>
        <button type="button" className="command-button" onClick={onRetry}>
          {t('panel.error.retry')}
        </button>
      </div>
    </div>
  )
}
