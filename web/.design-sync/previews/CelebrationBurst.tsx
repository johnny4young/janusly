import { CelebrationBurst } from '@janusly/web'

/**
 * The decorative burst Janusly plays at the two moments worth marking: the
 * Recovery Center reaching all-clear, and a recovery patch applying cleanly.
 *
 * It owns no timer. `trigger` is a counter, and changing it remounts the
 * particle group — which is how the same instance replays. `trigger <= 0`
 * renders nothing, and so does a reduced-motion preference: the burst is
 * `aria-hidden` decoration, so removing it costs no information.
 *
 * It is absolutely positioned and expects a positioned ancestor to burst from,
 * which the stage below supplies.
 *
 * A still frame can only show the burst part-way. The particles fade as they
 * travel, so the capture catches them faint and scattered rather than at full
 * opacity — that is the effect, not a broken preview. Their colours come from
 * `--we-accent`, `--we-primary` and `--we-warning`, cycled across the ten
 * particles.
 */
export function Playing() {
  return (
    <div
      style={{
        position: 'relative',
        minHeight: 220,
        display: 'grid',
        placeItems: 'center',
        background: 'var(--we-surface-3)',
        borderRadius: 12,
      }}
    >
      <CelebrationBurst trigger={1} />
    </div>
  )
}
