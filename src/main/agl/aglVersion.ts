import { AGL_MIN_VERSION } from '../../shared/agl'

const VERSION = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/

/** `agl 0.3.12`, `0.3.12` or `v0.3.12-dev` → the version; undefined when there is none. */
export function parseAglVersion(text: string | undefined | null): string | undefined {
  const match = typeof text === 'string' ? text.match(VERSION) : null
  return match ? match[0] : undefined
}

/**
 * Semver order of two versions: negative when `a` is older. A pre-release
 * (`0.3.12-dev`) is older than its release; pre-release tags compare as text.
 * Throws for text that is not a version, so callers decide what unknown means.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.match(VERSION), right = b.match(VERSION)
  if (!left || !right) throw new Error(`not a version: ${!left ? a : b}`)
  for (let index = 1; index <= 3; index++) {
    const difference = Number(left[index]) - Number(right[index])
    if (difference) return difference
  }
  if (left[4] === right[4]) return 0
  if (!left[4]) return 1
  if (!right[4]) return -1
  return left[4] < right[4] ? -1 : 1
}

export const isOlder = (a: string, b: string): boolean => compareVersions(a, b) < 0

/**
 * Whether to put the bundled agl into `<home>/bin/agl`: only when it is
 * missing, or a known older version. Never a downgrade, and never over a
 * binary whose version cannot be read (it may be the user's own build).
 */
export function shouldInstallBundled(installed: { exists: boolean; version?: string }, bundled: string | undefined): boolean {
  if (!bundled) return false
  if (!installed.exists) return true
  if (!installed.version) return false
  return isOlder(installed.version, bundled)
}

/** Whether an agl version has the features the desktop needs. */
export const meetsMinimum = (version: string | undefined): boolean => Boolean(version && !isOlder(version, AGL_MIN_VERSION))
