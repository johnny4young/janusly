import { PanelSearch } from '@janusly/web'

/**
 * The inline filter box the list panels (Templates, Packs) put above their
 * results. The parent owns both the query and the filtering — this is only
 * the labelled input affordance, matching the sidebar search.
 */

/** Empty, showing its placeholder. */
export function Empty() {
  return (
    <div style={{ maxWidth: 320 }}>
      <PanelSearch value="" placeholder="Filter templates" onChange={() => {}} />
    </div>
  )
}

/** Carrying a query. */
export function WithQuery() {
  return (
    <div style={{ maxWidth: 320 }}>
      <PanelSearch value="invoice" placeholder="Filter templates" onChange={() => {}} />
    </div>
  )
}

/** Full panel width, as the Packs panel renders it. */
export function FullWidth() {
  return <PanelSearch value="" placeholder="Filter solution packs" onChange={() => {}} />
}
