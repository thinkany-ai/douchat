/**
 * Returns `next`, but with every part that is deeply equal to the matching
 * part of `previous` replaced by that previous object. A snapshot arriving
 * over IPC is always a fresh copy, so without this every message, agent and
 * conversation gets a new identity on every update and no memoized row can
 * skip rendering. When nothing changed at all, `previous` itself comes back.
 *
 * Only plain objects and arrays are shared; anything else compares with `===`.
 */
export function replaceEqualDeep<T>(previous: unknown, next: T): T {
  if (previous === next) return next
  const previousArray = Array.isArray(previous)
  if (previousArray !== Array.isArray(next)) return next
  if (!previousArray && !(isPlainObject(previous) && isPlainObject(next))) return next

  if (previousArray) {
    const before = previous as unknown[]
    const after = next as unknown[]
    const shared = after.map((item, index) => replaceEqualDeep(before[index], item))
    const same = before.length === after.length && shared.every((item, index) => item === before[index])
    return (same ? before : shared) as T
  }

  const before = previous as Record<string, unknown>
  const after = next as Record<string, unknown>
  const keys = Object.keys(after)
  const shared: Record<string, unknown> = {}
  let same = Object.keys(before).length === keys.length
  for (const key of keys) {
    const value = replaceEqualDeep(before[key], after[key])
    shared[key] = value
    if (value !== before[key] || (value === undefined && !(key in before))) same = false
  }
  return (same ? before : shared) as T
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
