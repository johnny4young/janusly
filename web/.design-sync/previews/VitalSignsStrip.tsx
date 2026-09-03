import { VitalSignsStrip } from '@janusly/web'
import { Activity, CircleDollarSign, Clock, TrendingUp } from 'lucide-react'

/**
 * The metric row that opens Operations and Home. Every tile arrives
 * **pre-formatted and pre-translated** — the strip does no numeric formatting
 * of its own, so `display` is the exact string shown. `severity` tints the
 * left border and the value; `progressValue` (0–100) adds the thin bar.
 */

/** A healthy operation — the everyday state. */
export function Healthy() {
  return (
    <VitalSignsStrip
      ariaLabel="Operations vital signs"
      tiles={[
        {
          icon: <TrendingUp size={15} />,
          label: 'Workflow success rate',
          display: '99.2%',
          severity: 'healthy',
          progressValue: 99,
        },
        {
          icon: <Clock size={15} />,
          label: 'Median run time',
          display: '1m 30s',
          severity: 'neutral',
        },
        {
          icon: <Activity size={15} />,
          label: 'Runs today',
          display: '1,284',
          severity: 'info',
        },
        {
          icon: <CircleDollarSign size={15} />,
          label: 'Spend today',
          display: '$12.34',
          severity: 'neutral',
        },
      ]}
    />
  )
}

/** Something is wrong — the severity range, with rationale copy. */
export function Degraded() {
  return (
    <VitalSignsStrip
      ariaLabel="Operations vital signs"
      tiles={[
        {
          icon: <TrendingUp size={15} />,
          label: 'Workflow success rate',
          display: '71.4%',
          severity: 'unhealthy',
          rationale: '18 of 63 runs failed at the billing step',
          progressValue: 71,
        },
        {
          icon: <Clock size={15} />,
          label: 'Median run time',
          display: '4m 02s',
          severity: 'warn',
          rationale: 'Upstream latency is above its 90-day median',
        },
        {
          icon: <Activity size={15} />,
          label: 'Runs today',
          display: '63',
          severity: 'neutral',
        },
      ]}
    />
  )
}

/** Telemetry not available yet — the em-dash placeholder. */
export function NoData() {
  return (
    <VitalSignsStrip
      ariaLabel="Operations vital signs"
      tiles={[
        { icon: <TrendingUp size={15} />, label: 'Workflow success rate', display: '—', severity: 'neutral' },
        { icon: <Clock size={15} />, label: 'Median run time', display: '—', severity: 'neutral' },
        { icon: <Activity size={15} />, label: 'Runs today', display: '—', severity: 'neutral' },
      ]}
    />
  )
}
