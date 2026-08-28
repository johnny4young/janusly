import { BrandMark } from '@janusly/web'

/**
 * The Janusly mark: a cobalt→cyan gradient rounded square carrying the
 * three-node DAG glyph. Inline SVG, so it scales cleanly at any `size`.
 * `withWordmark` swaps the standalone icon for the full lockup.
 */

/** Default 32px icon, as it appears in the topbar. */
export function Default() {
  return <BrandMark />
}

/** The full lockup — mark plus wordmark, used on the boot screen. */
export function WithWordmark() {
  return <BrandMark size={40} withWordmark />
}

/** The size range the mark is used at, from list rows up to the boot screen. */
export function Sizes() {
  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
      <BrandMark size={20} />
      <BrandMark size={32} />
      <BrandMark size={48} />
      <BrandMark size={72} />
    </div>
  )
}
