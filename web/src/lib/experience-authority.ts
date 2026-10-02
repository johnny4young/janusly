import { currentAuthoringAuthority, ownCanvas } from './canvas-authority'
import { PLATFORM_TAG, subscribeToTags } from './query-cache'

/** Local source review also expires when consent or saved resources change. */
export function ownAuthoringExperience(
  onInvalidated: () => void,
  authorityForState = currentAuthoringAuthority,
): AbortController {
  const owner = ownCanvas(onInvalidated, authorityForState)
  const unsubscribe = subscribeToTags(
    [PLATFORM_TAG, 'authoring-experiences', 'memory', 'org-config', 'versions', 'workflows'],
    () => {
      if (owner.signal.aborted) return
      owner.abort()
      onInvalidated()
    },
  )
  owner.signal.addEventListener('abort', unsubscribe, { once: true })
  return owner
}
