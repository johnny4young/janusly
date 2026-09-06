import { en } from '~/i18n/en';
import { es } from '~/i18n/es';
import { SITE } from '~/lib/site';

export const DEFAULT_LOCALE = 'en';

export const LOCALES = [
  { code: 'en', path: '', label: 'English', shortLabel: 'EN', htmlLang: 'en', ogLocale: 'en_US' },
  { code: 'es', path: 'es', label: 'Español', shortLabel: 'ES', htmlLang: 'es', ogLocale: 'es_ES' },
] as const;

export type Locale = (typeof LOCALES)[number]['code'];

const DICTIONARIES = { en, es } as const;
const LOCALE_CODES = new Set<string>(LOCALES.map((locale) => locale.code));

export function isLocale(value: string | undefined): value is Locale {
  return Boolean(value && LOCALE_CODES.has(value));
}

export function t(locale: Locale) {
  return DICTIONARIES[locale];
}

export function getLocaleMeta(locale: Locale) {
  return LOCALES.find((item) => item.code === locale) ?? LOCALES[0];
}

export function getLocaleFromPath(pathname: string): Locale {
  const first = pathname.split('/').filter(Boolean)[0];
  return isLocale(first) ? first : DEFAULT_LOCALE;
}

export function stripLocaleFromPath(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  if (isLocale(segments[0])) segments.shift();
  const stripped = `/${segments.join('/')}`;
  return stripped === '/' ? '/' : stripped.replace(/\/$/, '');
}

function isExternalPath(path: string): boolean {
  return /^(?:[a-z]+:)?\/\//i.test(path) || path.startsWith('mailto:');
}

/** Prefix a site path with the locale segment (English stays unprefixed). */
export function localizePath(locale: Locale, path: string): string {
  if (isExternalPath(path) || path.startsWith('#')) return path;
  const [pathnameWithQuery, hash = ''] = path.split('#');
  const [pathname, query = ''] = pathnameWithQuery.split('?');
  const stripped = stripLocaleFromPath(pathname || '/');
  const localized = locale === DEFAULT_LOCALE ? stripped : `/es${stripped === '/' ? '' : stripped}`;
  return `${localized || '/'}${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`;
}

/** The same page in another locale. */
export function switchLocalePath(currentPath: string, targetLocale: Locale): string {
  return localizePath(targetLocale, stripLocaleFromPath(currentPath));
}

export function canonicalUrl(locale: Locale, pathname: string): string {
  return new URL(localizePath(locale, pathname), SITE.url).toString();
}

/** hreflang alternates for a page, x-default pointing at English. */
export function alternateLinks(pathname: string) {
  const stripped = stripLocaleFromPath(pathname);
  const links = LOCALES.map((item) => ({
    locale: item.code,
    hreflang: item.htmlLang,
    href: new URL(localizePath(item.code, stripped), SITE.url).toString(),
  }));
  return [
    ...links,
    { locale: DEFAULT_LOCALE as Locale, hreflang: 'x-default', href: new URL(stripped, SITE.url).toString() },
  ];
}
