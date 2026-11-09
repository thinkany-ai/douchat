import { expect, it } from 'vitest'
import { compareVersions, isOlder, meetsMinimum, parseAglVersion, shouldInstallBundled } from './aglVersion'

it('reads versions as agl prints them', () => {
  expect(parseAglVersion('agl 0.3.12\n')).toBe('0.3.12')
  expect(parseAglVersion('v0.4.0-dev.1')).toBe('0.4.0-dev.1')
  expect(parseAglVersion('agl')).toBeUndefined()
  expect(parseAglVersion(undefined)).toBeUndefined()
})

it('orders versions numerically, a pre-release before its release', () => {
  expect(compareVersions('0.3.12', '0.3.9')).toBeGreaterThan(0)
  expect(compareVersions('0.10.0', '0.9.99')).toBeGreaterThan(0)
  expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  expect(isOlder('0.3.12-dev', '0.3.12')).toBe(true)
  expect(isOlder('0.3.12', '0.3.12-dev')).toBe(false)
  expect(isOlder('0.3.12-alpha', '0.3.12-beta')).toBe(true)
  expect(() => compareVersions('latest', '0.3.12')).toThrow('not a version')
})

it('installs the bundled agl only when missing or older, never a downgrade', () => {
  expect(shouldInstallBundled({ exists: false }, '0.3.12')).toBe(true)
  expect(shouldInstallBundled({ exists: true, version: '0.3.11' }, '0.3.12')).toBe(true)
  expect(shouldInstallBundled({ exists: true, version: '0.3.12' }, '0.3.12')).toBe(false)
  // A newer agl (updated by agl itself or another product) is never replaced.
  expect(shouldInstallBundled({ exists: true, version: '0.4.0' }, '0.3.12')).toBe(false)
  // Nor one whose version cannot be read: it may be the user's own build.
  expect(shouldInstallBundled({ exists: true }, '0.3.12')).toBe(false)
  // Nothing bundled (a build without agl): nothing to install.
  expect(shouldInstallBundled({ exists: false }, undefined)).toBe(false)
})

it('requires the 0.3.12 feature set', () => {
  expect(meetsMinimum('0.3.12')).toBe(true)
  expect(meetsMinimum('0.4.0')).toBe(true)
  expect(meetsMinimum('0.3.11')).toBe(false)
  expect(meetsMinimum(undefined)).toBe(false)
})
