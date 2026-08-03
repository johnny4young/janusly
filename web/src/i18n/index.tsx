/**
 * Public i18n surface. Components import from here; non-React helpers import
 * the stable `t` function from `./runtime`.
 */

import {
  cloneElement,
  Fragment,
  isValidElement,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  bootstrapI18n,
  changeRuntimeLocale,
  ensureRuntimeNamespace,
  hasActiveRuntimeNamespace,
  initI18n,
} from './init'
import { resolveSystemLocale, getBrowserSystemLanguages } from './resolve'
import { getStoredLanguage, setStoredLanguage } from './storage'
import {
  COMMON_NAMESPACE,
  FALLBACK_LOCALE,
  isSupportedLanguage,
  SUPPORTED_LANGUAGES,
  type AppLanguage,
  type CatalogNamespace,
  type RuntimeLocale,
  type Translate,
  type TranslationOptions,
} from './resources'
import {
  getResolvedLocale,
  i18nRuntime,
  subscribeRuntimeLocale,
  t,
  type I18nRuntime,
} from './runtime'

export { initI18n }
export { bootstrapI18n }
export { changeRuntimeLocale }
export { resolveSystemLocale, getBrowserSystemLanguages }
export { getStoredLanguage, setStoredLanguage }
export { COMMON_NAMESPACE, FALLBACK_LOCALE, isSupportedLanguage, SUPPORTED_LANGUAGES }
export type { AppLanguage, RuntimeLocale }

export function I18nNamespaceGate({
  namespace,
  children,
}: {
  namespace: CatalogNamespace
  children: ReactNode
}) {
  if (!hasActiveRuntimeNamespace(namespace)) throw ensureRuntimeNamespace(namespace)
  return children
}
export {
  tValidationIssue,
  tReadinessIssue,
  tAiReviewIssue,
  tRunEvent,
  tFailureCluster,
  tHealthRationale,
  tRecoveryMetricRationale,
  tTemplateName,
  tTemplateDescription,
  tTemplateCategory,
  tToolDescription,
  tApiError,
  tServerFallback,
} from './server-events'
export { getResolvedLocale } from './runtime'

/**
 * Resolve an `AppLanguage` (which may be `'system'`) to a concrete runtime
 * locale. Used at boot and when the user changes the dropdown.
 */
export function resolveAppLanguage(language: AppLanguage): RuntimeLocale {
  if (language === 'system') return resolveSystemLocale(getBrowserSystemLanguages())
  return language
}

/**
 * Imperative locale change. Persistence happens only after the demand-loaded
 * catalog succeeds, so a transient chunk failure cannot trap the next boot.
 */
export function changeAppLanguage(language: AppLanguage): Promise<void> {
  const resolved = resolveAppLanguage(language)
  return changeRuntimeLocale(resolved).then(() => {
    setStoredLanguage(language)
  })
}

/** Subscribe a component to locale changes while keeping `t` reference-stable. */
export function useT(): { t: Translate; i18n: I18nRuntime } {
  useSyncExternalStore(
    subscribeRuntimeLocale,
    getResolvedLocale,
    getResolvedLocale,
  )
  return { t, i18n: i18nRuntime }
}

type RichComponents = Record<string, ReactElement> | readonly ReactElement[]

type RichNode = {
  tag: string | null
  children: ReactNode[]
}

function componentFor(
  components: RichComponents | undefined,
  tag: string,
): ReactElement | undefined {
  if (!components) return undefined
  if (Array.isArray(components)) {
    const index = Number(tag)
    return Number.isInteger(index) ? components[index] : undefined
  }
  return (components as Record<string, ReactElement>)[tag]
}

function renderRichText(
  text: string,
  components: RichComponents | undefined,
): ReactNode[] {
  const root: RichNode = { tag: null, children: [] }
  const stack: RichNode[] = [root]
  const token = /<\/?([A-Za-z][\w-]*|\d+)>/g
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = token.exec(text))) {
    if (match.index > cursor) stack.at(-1)!.children.push(text.slice(cursor, match.index))
    const raw = match[0]
    const tag = match[1]!
    if (raw.startsWith('</')) {
      const current = stack.at(-1)!
      if (stack.length === 1 || current.tag !== tag) {
        current.children.push(raw)
        cursor = token.lastIndex
        continue
      }
      const node = stack.pop()!
      const template = componentFor(components, tag)
      stack.at(-1)!.children.push(
        template && isValidElement(template)
          ? cloneElement(template, { key: `${tag}-${match.index}` }, node.children)
          : node.children,
      )
    } else {
      stack.push({ tag, children: [] })
    }
    cursor = token.lastIndex
  }

  if (cursor < text.length) stack.at(-1)!.children.push(text.slice(cursor))
  while (stack.length > 1) {
    const node = stack.pop()!
    stack.at(-1)!.children.push(`<${node.tag}>`, ...node.children)
  }
  return root.children
}

/**
 * Render trusted catalog markup through explicit React component templates.
 * Unknown or malformed tags degrade to text; no HTML is injected.
 */
export function Trans({
  i18nKey,
  values,
  components,
}: {
  i18nKey: string
  values?: TranslationOptions
  components?: RichComponents
}) {
  const { t } = useT()
  return <Fragment>{renderRichText(t(i18nKey, values), components)}</Fragment>
}
