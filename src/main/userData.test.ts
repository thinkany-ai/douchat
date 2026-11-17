import { describe, expect, it } from 'vitest'
import { applicationName, userDataDirectoryName } from './userData'

describe('user data directory', () => {
  it('isolates an unpackaged development build', () => {
    expect(applicationName(true)).toBe('Douchat Dev')
    expect(userDataDirectoryName(true)).toBe('douchat-dev')
  })

  it('keeps packaged builds on the stable production directory', () => {
    expect(applicationName(false)).toBe('Douchat')
    expect(userDataDirectoryName(false)).toBe('douchat')
    expect(userDataDirectoryName(false, 'local')).toBe('douchat')
  })

  it('runs a named development profile in its own directory', () => {
    expect(userDataDirectoryName(true, 'local')).toBe('douchat-dev-local')
    expect(userDataDirectoryName(true, ' Local ')).toBe('douchat-dev-local')
    for (const bad of ['', '../x', 'a/b', '-x']) expect(userDataDirectoryName(true, bad)).toBe('douchat-dev')
  })
})
