/**
 * Tagged invalidation for panel reads.
 *
 * A panel names the resources its data depends on; a mutation names the
 * resources it changed; only panels whose tags intersect refetch. This
 * replaces the store's `platformVersion` broadcast, which re-fetched every
 * mounted panel after any mutation. `PLATFORM_TAG` is the bridge: every
 * `bumpPlatformVersion()` still invalidates it, so a panel that subscribes
 * to `[PLATFORM_TAG, ...its own tags]` keeps refreshing on the broadcast
 * until every mutation names its tags, and can drop the bridge tag then.
 */
import { useEffect, useState } from 'react'

export const PLATFORM_TAG = 'platform'

type Listener = () => void
const subscribers = new Map<string, Set<Listener>>()

/** Run `listener` whenever any of `tags` is invalidated; returns unsubscribe. */
export function subscribeToTags(tags: readonly string[], listener: Listener): () => void {
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
export function invalidateTags(tags: readonly string[]): void {
  const pending = new Set<Listener>()
  for (const tag of tags) {
    for (const listener of subscribers.get(tag) ?? []) pending.add(listener)
  }
  for (const listener of pending) listener()
}

/**
 * A counter that advances when any of `tags` is invalidated: put it in a
 * fetch effect's dependency list where `platformVersion` used to be. `tags`
 * is read on mount; pass a stable array.
 */
export function useInvalidationNonce(tags: readonly string[]): number {
  const [nonce, setNonce] = useState(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tags are a stable declaration
  useEffect(() => subscribeToTags(tags, () => setNonce((current) => current + 1)), [])
  return nonce
}
