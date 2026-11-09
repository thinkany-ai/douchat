import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AglSettingsStore } from './aglSettingsStore'

let directory: string | undefined
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined })

it('has not asked yet on first launch, then keeps the answer and the linked account across launches', async () => {
  directory = await mkdtemp(join(tmpdir(), 'agl-settings-'))
  const file = join(directory, 'agl-settings.json')
  const store = new AglSettingsStore(file)
  expect(store.get()).toEqual({ autoLink: true, useForLocalAgents: false })
  expect(store.get().enabled).toBeUndefined()
  await store.save({ enabled: true, home: '/elsewhere', linkedAccount: 'mallory' })
  await store.setLinkedAccount('user_1')
  const again = new AglSettingsStore(file)
  expect(again.get()).toEqual({ enabled: true, autoLink: true, useForLocalAgents: false })
  expect(again.linkedAccount).toBe('user_1')
  // The UI cannot set the agl home or the linked account.
  expect(again.home).toBeUndefined()
  await again.save({ enabled: false })
  await again.setLinkedAccount(undefined)
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ enabled: false, autoLink: true, useForLocalAgents: false })
})

it('keeps a developer agl home from the file', async () => {
  directory = await mkdtemp(join(tmpdir(), 'agl-settings-'))
  const file = join(directory, 'agl-settings.json')
  await writeFile(file, JSON.stringify({ home: '/tmp/agl', enabled: 'yes' }))
  const store = new AglSettingsStore(file)
  expect(store.home).toBe('/tmp/agl')
  expect(store.get().enabled).toBeUndefined()
  await store.save({ autoLink: false })
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ home: '/tmp/agl', autoLink: false })
})
