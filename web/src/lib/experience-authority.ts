import { currentAuthoringAuthority, ownCanvas, type CanvasAuthoritySelector } from './canvas-authority'
import { PLATFORM_TAG, subscribeToTags } from './query-cache'

export const AUTHORING_EXPERIENCE_TAGS = [PLATFORM_TAG, 'authoring-experiences', 'memory', 'org-config',
  'versions', 'workflows', 'credentials', 'mcp'] as const

/** Local source review also expires when consent or saved resources change. */
export function ownAuthoringExperience(
  onInvalidated: () => void,
  authorityForState: CanvasAuthoritySelector = currentAuthoringAuthority,
): AbortController {
  const owner = ownCanvas(onInvalidated, authorityForState)
  const unsubscribe = subscribeToTags(
    AUTHORING_EXPERIENCE_TAGS,
    () => {
      if (owner.signal.aborted) return
      owner.abort()
      onInvalidated()
    },
  )
  owner.signal.addEventListener('abort', unsubscribe, { once: true })
  return owner
}
