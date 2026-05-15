/**
 * Compact locale switcher reused in two places: the Login auth-card corner
 * (`variant="auth-corner"`) and the UserMenu popover row
 * (`variant="popover-row"`). Renders a labelled `<select>` with three
 * options: System (auto-detect), English, Español.
 *
 * Used by `apps/web/src/components/Login.tsx` and
 * `apps/web/src/components/UserMenu.tsx`.
 */

import React from 'react'
import { Languages } from 'lucide-react'
import { changeAppLanguage, getStoredLanguage, useT } from './index'
import type { AppLanguage } from './resources'

type LocaleSwitcherProps = {
  /**
   * `auth-corner` floats inside the Login auth card; `popover-row` is a
   * full-width row inside the UserMenu popover.
   */
  variant: 'auth-corner' | 'popover-row'
}

/** Compact 3-option locale picker. Persists to localStorage on change. */
export function LocaleSwitcher({ variant }: LocaleSwitcherProps) {
  const { t } = useT()
  const [value, setValue] = React.useState<AppLanguage>(() => getStoredLanguage())

  const onChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value as AppLanguage
    setValue(next)
    changeAppLanguage(next)
  }

  const containerClass = variant === 'auth-corner' ? 'we-locale-switcher we-locale-switcher--corner' : 'we-locale-switcher we-locale-switcher--row'
  const selectId = `locale-switcher-${variant}`

  return (
    <div className={containerClass}>
      <label className="we-locale-switcher__label" htmlFor={selectId}>
        <Languages size={14} aria-hidden="true" />
        <span>{t('auth.userMenu.language')}</span>
      </label>
      <select
        id={selectId}
        className="we-locale-switcher__select text-field"
        value={value}
        onChange={onChange}
        aria-label={t('auth.locale.changeLanguage')}
      >
        <option value="system">{t('auth.locale.system')}</option>
        <option value="en">English</option>
        <option value="es">Español</option>
      </select>
    </div>
  )
}
