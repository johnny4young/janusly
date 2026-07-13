import { afterEach, describe, expect, it } from 'vitest'
import { useEffect, useState } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { useVirtualList, type UseVirtualListResult } from './useVirtualList'

afterEach(() => {
  cleanup()
})

type CapturedHandle<T> = { current: UseVirtualListResult<T> | null }

// Harness component: renders the hook, captures its result via a
// shared ref, and lets the test imperatively set the container's
// clientHeight + dispatch a scroll event. jsdom's ResizeObserver is a
// no-op shim, so the hook's scroll handler also re-reads clientHeight
// — driving both signals from one synthetic event keeps the test
// concise.
function Harness<T>(props: {
  items: readonly T[]
  rowHeight: number
  overscan?: number
  clientHeight?: number
  captured: CapturedHandle<T>
  getItemKey?: (item: T) => string | number
}) {
  const result = useVirtualList({
    items: props.items,
    rowHeight: props.rowHeight,
    overscan: props.overscan,
    getItemKey: props.getItemKey,
  })
  props.captured.current = result
  const containerRef = result.containerRef
  useEffect(() => {
    const container = containerRef.current
    if (container && props.clientHeight !== undefined) {
      Object.defineProperty(container, 'clientHeight', {
        configurable: true,
        value: props.clientHeight,
      })
      container.dispatchEvent(new Event('scroll'))
    }
  }, [containerRef, props.clientHeight])
  return <div ref={containerRef} data-testid="container" />
}

// Variant of Harness that forwards `resetScrollKey` — used by the
// cases that exercise the caller-controlled scroll-reset signal.
function KeyedHarness<T>(props: {
  items: readonly T[]
  rowHeight: number
  clientHeight?: number
  captured: CapturedHandle<T>
  resetScrollKey?: string | number | null
}) {
  const result = useVirtualList({
    items: props.items,
    rowHeight: props.rowHeight,
    resetScrollKey: props.resetScrollKey,
  })
  props.captured.current = result
  const containerRef = result.containerRef
  useEffect(() => {
    const container = containerRef.current
    if (container && props.clientHeight !== undefined) {
      Object.defineProperty(container, 'clientHeight', {
        configurable: true,
        value: props.clientHeight,
      })
      container.dispatchEvent(new Event('scroll'))
    }
  }, [containerRef, props.clientHeight])
  return <div ref={containerRef} data-testid="container" />
}

describe('useVirtualList', () => {
  it('renders all items when clientHeight is 0 (jsdom fallback)', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: `row-${i}` }))
    const captured: CapturedHandle<typeof items[number]> = { current: null }
    render(<Harness items={items} rowHeight={48} captured={captured} />)
    expect(captured.current?.visibleItems.length).toBe(50)
    expect(captured.current?.startOffset).toBe(0)
    expect(captured.current?.totalHeight).toBe(50 * 48)
  })

  it('windows correctly once clientHeight is measured', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `row-${i}` }))
    const captured: CapturedHandle<typeof items[number]> = { current: null }
    render(<Harness items={items} rowHeight={48} overscan={5} clientHeight={480} captured={captured} />)
    // The harness effect set clientHeight=480 and dispatched a scroll.
    // clientHeight 480 / rowHeight 48 = 10 visible rows.
    // scrollTop=0; startIndex = max(0, 0-5) = 0; endIndex = ceil(480/48)+5 = 15.
    await act(async () => { /* flush state updates triggered by the harness effect */ })
    expect(captured.current?.visibleItems.length).toBe(15)
    expect(captured.current?.visibleItems[0]?.index).toBe(0)
    expect(captured.current?.visibleItems[14]?.index).toBe(14)
    expect(captured.current?.startOffset).toBe(0)
  })

  it('clamps startIndex to 0 when scrollTop is small (overscan boundary)', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `row-${i}` }))
    const captured: CapturedHandle<typeof items[number]> = { current: null }
    render(<Harness items={items} rowHeight={50} overscan={5} clientHeight={200} captured={captured} />)
    await act(async () => { /* flush */ })
    // scrollTop=0. startIndex = max(0, floor(0/50) - 5) = max(0, -5) = 0.
    expect(captured.current?.visibleItems[0]?.index).toBe(0)
    expect(captured.current?.startOffset).toBe(0)
  })

  it('updates the window on scroll', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `row-${i}` }))
    const captured: CapturedHandle<typeof items[number]> = { current: null }
    render(<Harness items={items} rowHeight={50} overscan={5} clientHeight={250} captured={captured} />)
    await act(async () => { /* flush initial harness effect */ })
    expect(captured.current?.visibleItems.length).toBe(10)
    const container = captured.current?.containerRef.current
    if (!container) throw new Error('container ref not bound')
    await act(async () => {
      container.scrollTop = 500
      container.dispatchEvent(new Event('scroll'))
    })
    // startIndex = max(0, floor(500/50) - 5) = 10 - 5 = 5.
    // endIndex = min(100, ceil((500+250)/50) + 5) = 15 + 5 = 20. 15 items.
    expect(captured.current?.visibleItems[0]?.index).toBe(5)
    expect(captured.current?.visibleItems.at(-1)?.index).toBe(19)
    expect(captured.current?.startOffset).toBe(5 * 50)
  })

  it('resets scrollTop when resetScrollKey changes (filter swap signal)', async () => {
    const initial = Array.from({ length: 100 }, (_, i) => ({ id: `row-${i}` }))
    const filtered = initial.slice(0, 20)
    const captured: CapturedHandle<typeof initial[number]> = { current: null }
    function Reswapper() {
      const [items, setItems] = useState<readonly typeof initial[number][]>(initial)
      const [filterKey, setFilterKey] = useState<string>('all')
      return (
        <>
          <KeyedHarness items={items} rowHeight={50} clientHeight={250} captured={captured} resetScrollKey={filterKey} />
          <button data-testid="swap" onClick={() => { setItems(filtered); setFilterKey('partial') }}>swap</button>
        </>
      )
    }
    const { getByTestId } = render(<Reswapper />)
    await act(async () => { /* flush initial */ })
    const container = captured.current?.containerRef.current
    if (!container) throw new Error('container ref not bound')
    await act(async () => {
      container.scrollTop = 1000
      container.dispatchEvent(new Event('scroll'))
    })
    expect(captured.current?.visibleItems[0]?.index).toBeGreaterThan(0)
    // Swap items AND the resetScrollKey — the hook resets scroll only
    // because the key changed, not because the items reference did.
    await act(async () => {
      getByTestId('swap').click()
    })
    expect(container.scrollTop).toBe(0)
    expect(captured.current?.visibleItems[0]?.index).toBe(0)
  })

  it('does NOT reset scroll when items reference changes but resetScrollKey is stable', async () => {
    const captured: CapturedHandle<{ id: string }> = { current: null }
    function Refetcher() {
      // Simulate a platformVersion-driven refetch: every render
      // produces a NEW items array reference with identical content.
      const [tick, setTick] = useState(0)
      const items = Array.from({ length: 100 }, (_, i) => ({ id: `row-${i}` }))
      void tick
      return (
        <>
          <KeyedHarness items={items} rowHeight={50} clientHeight={250} captured={captured} resetScrollKey="stable-filter" />
          <button data-testid="refetch" onClick={() => setTick((n) => n + 1)}>refetch</button>
        </>
      )
    }
    const { getByTestId } = render(<Refetcher />)
    await act(async () => { /* flush initial */ })
    const container = captured.current?.containerRef.current
    if (!container) throw new Error('container ref not bound')
    await act(async () => {
      container.scrollTop = 800
      container.dispatchEvent(new Event('scroll'))
    })
    expect(container.scrollTop).toBe(800)
    // Trigger a refetch — items get a new reference, but resetScrollKey
    // is unchanged, so scroll position MUST be preserved.
    await act(async () => {
      getByTestId('refetch').click()
    })
    expect(container.scrollTop).toBe(800)
  })

  it('clamps scrollTop when the list shrinks under a stable resetScrollKey', async () => {
    const captured: CapturedHandle<{ id: string }> = { current: null }
    function Shrinker() {
      const [count, setCount] = useState(100)
      const items = Array.from({ length: count }, (_, i) => ({ id: `row-${i}` }))
      return (
        <>
          <KeyedHarness items={items} rowHeight={50} clientHeight={250} captured={captured} resetScrollKey="open" />
          <button data-testid="shrink" onClick={() => setCount(10)}>shrink</button>
        </>
      )
    }
    const { getByTestId } = render(<Shrinker />)
    await act(async () => { /* flush initial */ })
    const container = captured.current?.containerRef.current
    if (!container) throw new Error('container ref not bound')
    await act(async () => {
      container.scrollTop = 4000
      container.dispatchEvent(new Event('scroll'))
    })
    expect(captured.current?.visibleItems.length).toBeGreaterThan(0)

    await act(async () => {
      getByTestId('shrink').click()
    })

    // New totalHeight=500 and clientHeight=250, so maxScrollTop is 250.
    expect(container.scrollTop).toBe(250)
    expect(captured.current?.visibleItems.length).toBeGreaterThan(0)
    expect(captured.current?.visibleItems.at(-1)?.index).toBe(9)
  })

  it('computes totalHeight as items.length × rowHeight regardless of measurement', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `row-${i}` }))
    const captured: CapturedHandle<typeof items[number]> = { current: null }
    render(<Harness items={items} rowHeight={60} clientHeight={0} captured={captured} />)
    expect(captured.current?.totalHeight).toBe(7 * 60)
  })

  it('scrolls to a bounded index with center alignment', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `row-${i}` }))
    const captured: CapturedHandle<typeof items[number]> = { current: null }
    render(<Harness items={items} rowHeight={50} clientHeight={250} captured={captured} />)
    await act(async () => { /* flush initial measurement */ })
    const container = captured.current?.containerRef.current
    if (!container) throw new Error('container ref not bound')

    await act(async () => captured.current?.scrollToIndex(20, 'center'))

    // Row 20 starts at 1000; centering subtracts (250 - 50) / 2.
    expect(container.scrollTop).toBe(900)
    expect(captured.current?.visibleItems.some(item => item.index === 20)).toBe(true)
  })

  it('preserves the visible item and intra-row offset when live items are prepended', async () => {
    const captured: CapturedHandle<{ id: string }> = { current: null }
    function LivePrepender() {
      const [items, setItems] = useState(() => Array.from({ length: 40 }, (_, i) => ({ id: `row-${i}` })))
      return (
        <>
          <Harness
            items={items}
            rowHeight={50}
            clientHeight={250}
            captured={captured}
            getItemKey={item => item.id}
          />
          <button
            data-testid="prepend"
            onClick={() => setItems(current => [
              { id: 'new-0' },
              { id: 'new-1' },
              ...current,
            ])}
          >
            prepend
          </button>
        </>
      )
    }
    const { getByTestId } = render(<LivePrepender />)
    await act(async () => { /* flush initial measurement */ })
    const container = captured.current?.containerRef.current
    if (!container) throw new Error('container ref not bound')
    await act(async () => {
      container.scrollTop = 525
      container.dispatchEvent(new Event('scroll'))
    })

    await act(async () => getByTestId('prepend').click())

    // row-10 was 25px into the viewport. Two prepended rows move its index
    // from 10 to 12, so preserving the anchor requires +100px.
    expect(container.scrollTop).toBe(625)
    expect(captured.current?.visibleItems.some(({ item }) => item.id === 'row-10')).toBe(true)
  })
})
