import { expect, it } from 'vitest'
import { AGL_GRACE_MS, AglGraceWindows, aglGraceRemaining } from './aglGrace'

it('counts the window from createdAt, clamping clock skew both ways', () => {
  const now = 1_000_000
  expect(AGL_GRACE_MS).toBe(30_000)
  expect(aglGraceRemaining(now - 10_000, now)).toBe(20_000)
  expect(aglGraceRemaining(new Date(now - 10_000).toISOString(), now)).toBe(20_000)
  // A clock ahead of this one never stretches the wait past the window.
  expect(aglGraceRemaining(now + 3_600_000, now)).toBe(30_000)
  // Old (or a clock behind): the wait is over.
  expect(aglGraceRemaining(now - 3_600_000, now)).toBe(0)
  // Unknown: the whole window from first sight.
  expect(aglGraceRemaining(undefined, now)).toBe(30_000)
  expect(aglGraceRemaining('not a date', now)).toBe(30_000)
})

it('fixes each deadline at first sight and forgets ids no longer pending', () => {
  let now = 0
  const windows = new AglGraceWindows(() => now)
  expect(windows.waiting('a', undefined)).toBe(true)
  now = 29_999
  // Seeing it again does not restart the window, even with a fresher createdAt.
  expect(windows.waiting('a', now)).toBe(true)
  expect(windows.remaining('a')).toBe(1)
  now = 30_000
  expect(windows.waiting('a', now)).toBe(false)
  expect(windows.remaining('a')).toBe(0)
  windows.retain([])
  expect(windows.waiting('a', now)).toBe(true)
})
