/**
 * Theme manager — persists the user's theme preference (`system` / `light` /
 * `dark`) in localStorage and applies it to `<html data-theme>` so the
 * `:root` + `[data-theme="dark"]` token blocks in `styles/foundations.css` resolve.
 *
 * `applyTheme` is called from `main.tsx` BEFORE `createRoot` so the dark
 * tokens are in place during first paint (no light→dark flicker). UserMenu's
 * theme segmented control calls `setTheme()` to persist + apply on click.
 *
 * `system` mode listens to `matchMedia('(prefers-color-scheme: dark)')` and
 * updates the DOM live; `light`/`dark` modes ignore the media query.
 */

export type ThemePreference = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'janusly:theme'
const DENSITY_KEY = 'janusly:density'

export type DensityPreference = 'comfortable' | 'compact'

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // localStorage may be unavailable (Safari private mode); swallow.
  }
}

export function getStoredTheme(): ThemePreference {
  const stored = safeGet(STORAGE_KEY)
  if (stored === 'system' || stored === 'light' || stored === 'dark') return stored
  return 'system'
}

export function getStoredDensity(): DensityPreference {
  const stored = safeGet(DENSITY_KEY)
  return stored === 'compact' ? 'compact' : 'comfortable'
}

export function resolveSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function effectiveTheme(pref: ThemePreference): 'light' | 'dark' {
  return pref === 'system' ? resolveSystemTheme() : pref
}

export function applyTheme(pref: ThemePreference): void {
  if (typeof document === 'undefined') return
  const resolved = effectiveTheme(pref)
  document.documentElement.dataset.theme = resolved
}

export function applyDensity(pref: DensityPreference): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.density = pref
}

export function setTheme(pref: ThemePreference): void {
  safeSet(STORAGE_KEY, pref)
  applyTheme(pref)
}

export function setDensity(pref: DensityPreference): void {
  safeSet(DENSITY_KEY, pref)
  applyDensity(pref)
}

let mediaQueryListener: ((event: MediaQueryListEvent) => void) | null = null

/** Wire the system-pref media query so `system` mode tracks OS changes live. */
export function bindSystemThemeListener(): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  if (mediaQueryListener) {
    if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', mediaQueryListener)
    else if (typeof mq.removeListener === 'function') mq.removeListener(mediaQueryListener)
  }
  mediaQueryListener = () => {
    if (getStoredTheme() === 'system') applyTheme('system')
  }
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', mediaQueryListener)
  else if (typeof mq.addListener === 'function') mq.addListener(mediaQueryListener)
}

/** Boot helper — applies stored preferences once at startup. */
export function bootTheme(): void {
  applyTheme(getStoredTheme())
  applyDensity(getStoredDensity())
  bindSystemThemeListener()
}
