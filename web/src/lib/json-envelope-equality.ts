import { isRecord } from './guards'

// Compare JSON envelopes without recursion or key-order assumptions. Cyclic
// objects supplied directly by a plugin/test are rejected; network JSON can
// never contain them.
export function jsonEquivalent(left: unknown, right: unknown): boolean {
  const pending: Array<[unknown, unknown]> = [[left, right]]
  const compared = new WeakMap<object, WeakSet<object>>()
  while (pending.length > 0) {
    const pair = pending.pop()
    if (!pair) return false
    const [currentLeft, currentRight] = pair
    if (currentLeft === currentRight) {
      if (currentLeft === null || typeof currentLeft !== 'object') continue
      return false
    }
    if (currentLeft !== null && currentRight !== null
      && typeof currentLeft === 'object' && typeof currentRight === 'object') {
      let rightObjects = compared.get(currentLeft)
      if (rightObjects?.has(currentRight)) return false
      if (!rightObjects) {
        rightObjects = new WeakSet<object>()
        compared.set(currentLeft, rightObjects)
      }
      rightObjects.add(currentRight)
    }
    if (Array.isArray(currentLeft) || Array.isArray(currentRight)) {
      if (!Array.isArray(currentLeft) || !Array.isArray(currentRight)
        || currentLeft.length !== currentRight.length) return false
      for (let index = 0; index < currentLeft.length; index += 1) {
        pending.push([currentLeft[index], currentRight[index]])
      }
      continue
    }
    if (!isRecord(currentLeft) || !isRecord(currentRight)) return false
    const leftKeys = Object.keys(currentLeft)
    const rightKeys = Object.keys(currentRight)
    if (leftKeys.length !== rightKeys.length || leftKeys.some((key) => !Object.hasOwn(currentRight, key))) return false
    for (const key of leftKeys) pending.push([currentLeft[key], currentRight[key]])
  }
  return true
}
