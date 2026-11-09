import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AglSettingsStore } from './aglSettingsStore'
import { bundledAglPath, createLocalSession, installAglBinary, localSessionParams, resolveAglHome, runAgl } from './aglLocal'

let directory = ''
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'douchat-agl-local-')) })
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('takes the agl home from one setting, and leaves the shared ~/.agl alone in development', () => {
  const shared = join(homedir(), '.agl')
  expect(resolveAglHome({ development: false, platform: 'darwin' })).toEqual({ home: shared, defaultHome: true, enabled: true })
  expect(resolveAglHome({ development: true, platform: 'darwin' })).toEqual({ home: shared, defaultHome: true, enabled: false })
  expect(resolveAglHome({ env: '/tmp/agl-test', development: true, platform: 'linux' })).toEqual({ home: '/tmp/agl-test', defaultHome: false, enabled: true })
  // The environment wins over the saved setting; `~/.agl` named explicitly is the shared home.
  expect(resolveAglHome({ env: '~/.agl', setting: '/elsewhere', development: true, platform: 'darwin' })).toEqual({ home: shared, defaultHome: true, enabled: true })
  expect(resolveAglHome({ setting: '/elsewhere', development: false, platform: 'darwin' }).home).toBe('/elsewhere')
  expect(resolveAglHome({ development: false, platform: 'win32' }).enabled).toBe(false)
})

it('finds the bundled agl: the override, the packaged resource, or the fetched development copy', () => {
  const base = { packaged: true, resourcesPath: '/App.app/Contents/Resources', appPath: '/repo', platform: 'darwin' as const, arch: 'arm64' }
  expect(bundledAglPath(base)).toBe('/App.app/Contents/Resources/bin/agl')
  expect(bundledAglPath({ ...base, packaged: false })).toBe('/repo/resources/bin/darwin-arm64/agl')
  expect(bundledAglPath({ ...base, env: '/build/agl' })).toBe('/build/agl')
  expect(bundledAglPath({ ...base, platform: 'win32' })).toBeUndefined()
})

it('creates every desktop session local-only and without history on disk', async () => {
  expect(localSessionParams({ agent: 'claude', name: 'douchat:x', visibility: 'shared', history: true })).toEqual({ agent: 'claude', name: 'douchat:x', visibility: 'local', history: false })
  const client = { createSession: vi.fn(async (params: object) => ({ id: 's', ...params }) as never) }
  await createLocalSession(client, { agent: 'codex', cwd: '/repo' })
  expect(client.createSession).toHaveBeenCalledWith({ agent: 'codex', cwd: '/repo', visibility: 'local', history: false })
})

it('installs a binary atomically and only if it runs', async () => {
  const source = join(directory, 'agl-src')
  writeFileSync(source, '#!/bin/sh\necho "agl 0.3.12"\n')
  const target = join(directory, 'home', 'bin', 'agl')
  await installAglBinary(source, target)
  expect(readFileSync(target, 'utf8')).toContain('agl 0.3.12')
  expect((await runAgl(target, ['--version'], { env: {}, timeoutMs: 5_000 })).stdout.trim()).toBe('agl 0.3.12')
  const broken = join(directory, 'broken')
  writeFileSync(broken, '#!/bin/sh\nexit 3\n')
  chmodSync(broken, 0o755)
  await expect(installAglBinary(broken, target)).rejects.toThrow('does not run here')
  // The working copy is still in place.
  expect(readFileSync(target, 'utf8')).toContain('agl 0.3.12')
  expect((await runAgl(join(directory, 'missing'), [], { env: {}, timeoutMs: 1_000 })).code).toBeNull()
})

it('keeps agl settings, defaulting to auto-link on and agl detection off', async () => {
  const file = join(directory, 'agl-settings.json')
  const store = new AglSettingsStore(file)
  expect(store.get()).toEqual({ autoLink: true, useForLocalAgents: false })
  expect(await store.save({ useForLocalAgents: true, home: '/sneaky', other: 1 })).toEqual({ autoLink: true, useForLocalAgents: true })
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ autoLink: true, useForLocalAgents: true })
  writeFileSync(file, JSON.stringify({ autoLink: false, home: '/tmp/dev-agl' }))
  const again = new AglSettingsStore(file)
  expect(again.get()).toEqual({ autoLink: false, useForLocalAgents: false })
  expect(again.home).toBe('/tmp/dev-agl')
  await again.save({ autoLink: true })
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ autoLink: true, useForLocalAgents: false, home: '/tmp/dev-agl' })
})
