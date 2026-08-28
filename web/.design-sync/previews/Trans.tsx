import { Trans } from '@janusly/web'

/**
 * Interpolates React elements into a translated string, so translators keep
 * one sentence with markup in it instead of a set of fragments the code has
 * to reassemble. `components` maps either by tag name (`<code>…</code>`) or by
 * index (`<0>…</0>`), matching whichever form the catalog entry uses.
 *
 * All three cells render real keys from `src/i18n/locales/en/common.json`.
 */

/** Named-tag mapping — the form most Janusly helper strings use. */
export function NamedComponents() {
  return (
    <p style={{ margin: 0, maxWidth: 560, fontSize: 13, lineHeight: 1.6, color: 'var(--we-text-2)' }}>
      <Trans i18nKey="rightPanel.quickConfig.httpJsonHelper" components={{ code: <code /> }} />
    </p>
  )
}

/** Indexed mapping plus interpolated values. */
export function IndexedWithValues() {
  return (
    <p style={{ margin: 0, maxWidth: 560, fontSize: 13, lineHeight: 1.6, color: 'var(--we-text-2)' }}>
      <Trans
        i18nKey="budgetBanner.detail"
        values={{ spent: '48.20', limit: '50.00' }}
        components={[<strong key="spent" />, <strong key="limit" />]}
      />
    </p>
  )
}

/** A longer string carrying several inline code spans. */
export function MultipleTags() {
  return (
    <p style={{ margin: 0, maxWidth: 560, fontSize: 13, lineHeight: 1.6, color: 'var(--we-text-2)' }}>
      <Trans i18nKey="mcpConnections.helper" components={{ code: <code /> }} />
    </p>
  )
}
