/**
 * Tiny windowing helper for unbounded operator lists. Attaches a
 * ResizeObserver + passive scroll listener to a scrollable container
 * ref and returns the slice of items currently visible inside it,
 * with the offset + total-height pair the caller uses to maintain the
 * scrollbar position.
 *
 * Usage:
 *   const { containerRef, visibleItems, totalHeight, startOffset } =
 *     useVirtualList({ items: rows, rowHeight: 48 })
 *   return (
 *     <div ref={containerRef} className="we-virtual-list">
 *       <div style={{ height: totalHeight, position: 'relative' }}>
 *         <ul style={{ transform: `translateY(${startOffset}px)` }}>
 *           {visibleItems.map(({ item }) => <Row key={item.id} item={item} />)}
 *         </ul>
 *       </div>
 *     </div>
 *   )
 *
 * Renders ALL items when `clientHeight === 0` (initial paint, jsdom
 * default, SSR). The "correct window when container height is 0 at
 * first paint" requirement maps to this fallback so component tests
 * using `@testing-library/react` keep finding mid-list rows in the
 * absence of a measured layout. Once the real container layout
 * resolves, `ResizeObserver` fires and the hook switches to windowed
 * mode.
 *
 * Used by:
 * - `apps/web/src/components/DeadLettersPanel.tsx` (primary —
 *   100-200 DLQ rows in the Recovery Center).
 * - Future operator panels with comparable list lengths land here.
 *
 * Invariants:
 * - The `containerRef` MUST be attached to the element that owns the
 *   vertical scroll (the element with `overflow-y: auto`). The hook
 *   reads `clientHeight` + `scrollTop` from that element directly.
 * - The wrapper inside the container MUST have
 *   `height: totalHeight; position: relative` so the scrollbar
 *   reflects the full list and `startOffset` positions the window.
 * - Row heights are fixed per call to the hook. Dynamic / variable
 *   row heights are out of scope; lift the rowHeight to the tallest
 *   row in the list, or split into multiple lists.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

/** Hook arguments. */
export type UseVirtualListArgs<T> = {
  /** Source items. The hook re-windows whenever this reference changes. */
  items: readonly T[]
  /** Fixed row height in CSS pixels. Used for both totalHeight and the slice math. */
  rowHeight: number
  /** Rows rendered above + below the visible window so scroll feels fluid. Default 5. */
  overscan?: number
  /**
   * Optional signal that the visible set semantically changed (e.g.,
   * a filter swap) and the container's `scrollTop` should reset to 0.
   * Pass a stable value (string / number) that the caller controls;
   * the hook resets scroll whenever this value changes.
   *
   * **Why not just listen on `items`?** A parent that refetches its
   * data on every `platformVersion` bump produces a new `items`
   * array reference even when the content is identical. Tying scroll
   * reset to the array reference would silently jump the operator's
   * scroll position to 0 on every bump. Pass `resetScrollKey` from
   * the filter / sort signal you actually want to reset on; omit it
   * to disable auto-reset and manage scroll yourself.
   */
  resetScrollKey?: string | number | null
}

/** Hook return shape. */
export type UseVirtualListResult<T> = {
  /** Attach to the element with `overflow-y: auto`. */
  containerRef: React.RefObject<HTMLDivElement | null>
  /** Items inside the current window, each tagged with its absolute index in `items`. */
  visibleItems: ReadonlyArray<{ item: T; index: number }>
  /** Total height of the virtual list — set on the inner wrapper to maintain the scrollbar. */
  totalHeight: number
  /** `translateY` offset for the inner wrapper so visible rows align with their virtual index. */
  startOffset: number
}

const DEFAULT_OVERSCAN = 5

export function useVirtualList<T>({
  items,
  rowHeight,
  overscan = DEFAULT_OVERSCAN,
  resetScrollKey,
}: UseVirtualListArgs<T>): UseVirtualListResult<T> {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const didResetScrollRef = useRef(false)
  const [clientHeight, setClientHeight] = useState<number>(0)
  const [scrollTop, setScrollTop] = useState<number>(0)

  // Reset the container's scroll position when the caller-controlled
  // signal changes. Decoupling this from `items` means a parent
  // refetch that produces a new array reference with identical
  // content (the platformVersion-bump common case) leaves the
  // operator's scroll position alone. Callers that DO want
  // refetch-based resets pass `resetScrollKey: items.length` (or
  // similar) explicitly. Effect is skipped entirely when
  // `resetScrollKey` is undefined.
  useEffect(() => {
    if (resetScrollKey === undefined) return
    const container = containerRef.current
    if (container) container.scrollTop = 0
    didResetScrollRef.current = true
    setScrollTop(0)
  }, [resetScrollKey])

  // ResizeObserver fires once on mount with the measured height, then
  // on every layout change. `getBoundingClientRect` is the fallback
  // when ResizeObserver doesn't run (very old jsdom, SSR snapshot).
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const updateHeight = () => {
      setClientHeight(container.clientHeight)
    }
    updateHeight()
    if (typeof ResizeObserver === 'undefined') {
      // No-op in environments without ResizeObserver — the height
      // stays at the initial `updateHeight()` reading and the
      // jsdom-0-height fallback kicks in if that's 0.
      return
    }
    const observer = new ResizeObserver(updateHeight)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Passive scroll listener — `scrollTop` drives the window math.
  // The listener also re-reads `clientHeight` so test environments
  // without a working ResizeObserver (jsdom ships a no-op shim) can
  // drive both signals via a single synthetic scroll event after
  // manually overriding the container's clientHeight.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onScroll = () => {
      setScrollTop(container.scrollTop)
      setClientHeight(container.clientHeight)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [])

  const totalHeight = items.length * rowHeight

  // If the list shrinks while the reset key stays stable, an old
  // scrollTop can point past the new end and produce an empty window.
  // Clamp the stored position to the new maximum without treating every
  // refetch as a semantic "jump back to the top".
  useEffect(() => {
    if (didResetScrollRef.current) {
      didResetScrollRef.current = false
      return
    }
    if (clientHeight === 0) return
    const maxScrollTop = Math.max(0, totalHeight - clientHeight)
    if (scrollTop <= maxScrollTop) return
    const container = containerRef.current
    if (container) container.scrollTop = maxScrollTop
    setScrollTop(maxScrollTop)
  }, [clientHeight, scrollTop, totalHeight])

  const { visibleItems, startOffset } = useMemo(() => {
    if (clientHeight === 0) {
      // jsdom-0-height fallback: render all items. Tests using
      // @testing-library/react don't have a measured container and
      // would otherwise miss mid-list rows. Production code paths
      // upgrade to windowed mode once ResizeObserver fires.
      return {
        visibleItems: items.map((item, index) => ({ item, index })),
        startOffset: 0,
      }
    }
    const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
    const endIndex = Math.min(
      items.length,
      Math.ceil((scrollTop + clientHeight) / rowHeight) + overscan,
    )
    const window: Array<{ item: T; index: number }> = []
    for (let i = startIndex; i < endIndex; i += 1) {
      const item = items[i]
      if (item !== undefined) window.push({ item, index: i })
    }
    return { visibleItems: window, startOffset: startIndex * rowHeight }
  }, [items, clientHeight, scrollTop, rowHeight, overscan])

  return { containerRef, visibleItems, totalHeight, startOffset }
}
