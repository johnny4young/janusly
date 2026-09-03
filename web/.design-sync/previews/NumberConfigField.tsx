import { NumberConfigField } from '@janusly/web'

/**
 * Numeric config input. The parent owns the value and receives a `number`,
 * so callers never parse strings themselves.
 */

/** A retry count, as the resilience editor renders it. */
export function RetryCount() {
  return <NumberConfigField scope="resilience" label="Max attempts" value={3} onChange={() => {}} />
}

/** A larger value — a timeout in milliseconds. */
export function TimeoutMs() {
  return (
    <NumberConfigField scope="timing" label="Timeout (ms)" value={30000} onChange={() => {}} />
  )
}

/** Several numeric fields as the timing editor stacks them. */
export function Stacked() {
  return (
    <div>
      <NumberConfigField scope="timing" label="Max attempts" value={5} onChange={() => {}} />
      <NumberConfigField scope="timing" label="Backoff (ms)" value={1000} onChange={() => {}} />
      <NumberConfigField scope="timing" label="Timeout (ms)" value={30000} onChange={() => {}} />
    </div>
  )
}
