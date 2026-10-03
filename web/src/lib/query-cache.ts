/**
 * Tagged invalidation for panel reads.
 *
 * A panel names the resources its data depends on; a mutation names the
 * resources it changed; only panels whose tags intersect refetch.
 * `PLATFORM_TAG` lets cross-domain mutations request a full refresh:
 * panels subscribe to `[PLATFORM_TAG, ...their own tags]`.
 */
import { useCallback, useEffect, useState } from 'react'

export const PLATFORM_TAG = 'platform'

/** Resources a panel can depend on and a mutation can name. */
export type ResourceTag =
  | typeof PLATFORM_TAG
  | 'authoring-experiences' | 'alert-policies' | 'auth-policy' | 'auto-healing' | 'billing' | 'campaigns'
  | 'credentials' | 'dlq' | 'experiments' | 'external-runtimes' | 'health'
  | 'mcp' | 'members' | 'memory' | 'onboarding' | 'org-config' | 'packs'
  | 'recovery' | 'roles' | 'rollouts' | 'runs' | 'schedules' | 'scim'
  | 'slack-interactions' | 'upstream' | 'usage' | 'versions' | 'workflows'

type Listener = () => void
const subscribers = new Map<ResourceTag, Set<Listener>>()

/** Run `listener` whenever any of `tags` is invalidated; returns unsubscribe. */
export function subscribeToTags(tags: readonly ResourceTag[], listener: Listener): () => void {
  for (const tag of tags) {
    let set = subscribers.get(tag)
    if (!set) subscribers.set(tag, (set = new Set()))
    set.add(listener)
  }
  return () => {
    for (const tag of tags) {
      const set = subscribers.get(tag)
      if (!set) continue
      set.delete(listener)
      if (set.size === 0) subscribers.delete(tag)
    }
  }
}

/** Tell every subscriber of `tags` that its data may be stale. A listener
 *  subscribed through several matching tags runs once. */
export function invalidateTags(tags: readonly ResourceTag[]): void {
  const pending = new Set<Listener>()
  for (const tag of tags) {
    for (const listener of subscribers.get(tag) ?? []) pending.add(listener)
  }
  for (const listener of pending) listener()
}

/** One local counter for resource invalidation and an explicit retry or ownership refresh. */
export function useResourceRefresh(tags: readonly ResourceTag[]): readonly [number, () => void] {
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => setNonce(current => current + 1), [])
  useEffect(() => subscribeToTags(tags, refresh), [tags, refresh])
  return [nonce, refresh]
}

/** Resource-only readers retain the nonce interface; pass a stable tag array. */
export function useInvalidationNonce(tags: readonly ResourceTag[]): number {
  return useResourceRefresh(tags)[0]
}
