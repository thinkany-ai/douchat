import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ensureExtraPaths, mergeExtraPaths } from './aglConfig'

const owned = '/Users/me/Library/Application Support/Douchat/local-tools'
const wanted = [`${owned}/agents/bin`, `${owned}/node-v22.1.0-darwin-arm64/bin`]
const shared = {
  port: 7799, machine_id: 'm-1', default_access: 'full', hubs: [{ url: 'https://other.example/agl', token: 'aglm_secret', access: 'ask', share_local: true }],
  custom_agents: [{ id: 'goose', command: 'goose', args: ['acp'], protocol: 'acp' }], some_future_key: { nested: true }
}

it('adds Douchat’s folders and keeps every other key and entry as it is', () => {
  const text = JSON.stringify({ ...shared, extra_paths: ['~/Library/Application Support/OtherApp/bin'] })
  const merged = mergeExtraPaths(text, wanted, owned)
  expect(merged.changed).toBe(true)
  const config = JSON.parse(merged.text)
  expect(config).toEqual({ ...shared, extra_paths: ['~/Library/Application Support/OtherApp/bin', ...wanted] })
  // Key order is kept too.
  expect(Object.keys(config)).toEqual([...Object.keys(shared), 'extra_paths'])
})

it('creates extra_paths when missing, and changes nothing when already there', () => {
  const merged = mergeExtraPaths(JSON.stringify(shared), wanted, owned)
  expect(JSON.parse(merged.text).extra_paths).toEqual(wanted)
  const again = mergeExtraPaths(merged.text, wanted, owned)
  expect(again).toEqual({ text: merged.text, changed: false, extraPaths: wanted })
})

it('removes only its own stale entries (an older managed runtime), never other products’', () => {
  const text = JSON.stringify({ extra_paths: ['/opt/other/bin', `${owned}/node-v20.0.0-darwin-arm64/bin`, `${owned}/agents/bin`, `${owned}-not-ours/bin`, 42] })
  const merged = mergeExtraPaths(text, wanted, owned)
  expect(JSON.parse(merged.text).extra_paths).toEqual(['/opt/other/bin', `${owned}/agents/bin`, `${owned}-not-ours/bin`, 42, `${owned}/node-v22.1.0-darwin-arm64/bin`])
  expect(merged.extraPaths).not.toContain(42)
})

it('refuses to rewrite a file it does not understand', () => {
  expect(() => mergeExtraPaths('[1,2]', wanted, owned)).toThrow('not a JSON object')
  expect(() => mergeExtraPaths('{"extra_paths":"/bin"}', wanted, owned)).toThrow('not a list')
  expect(() => mergeExtraPaths('{not json', wanted, owned)).toThrow()
})

let home = ''
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'douchat-agl-config-')) })
afterEach(() => rmSync(home, { recursive: true, force: true }))

it('writes config.json in place with mode 0600, and leaves a missing file to agl', async () => {
  expect(await ensureExtraPaths(home, wanted, owned)).toBeUndefined()
  const file = join(home, 'config.json')
  writeFileSync(file, JSON.stringify(shared), { mode: 0o600 })
  expect(await ensureExtraPaths(home, wanted, owned)).toEqual({ changed: true, extraPaths: wanted })
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...shared, extra_paths: wanted })
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(await ensureExtraPaths(home, wanted, owned)).toEqual({ changed: false, extraPaths: wanted })
})
