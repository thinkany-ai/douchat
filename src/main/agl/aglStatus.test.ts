import { expect, it } from 'vitest'
import { douchatHubLink, normalizeHubUrl, parseAglStatus, parseAglUpdate } from './aglStatus'

it('parses agl status --json with and without a daemon', () => {
  // As printed by agl 0.3.12 with no daemon running.
  expect(parseAglStatus(`{
  "busy": null, "daemon_version": null, "hubs": [], "machine_id": "a3862336-b1e3-4294-bf63-d8bb82c146d5",
  "managed": null, "pid": null, "running": false, "service": true, "version": "0.3.12"
}`)).toEqual({ version: '0.3.12', running: false, machineId: 'a3862336-b1e3-4294-bf63-d8bb82c146d5', service: true, hubs: [] })
  expect(parseAglStatus(JSON.stringify({
    version: '0.3.12', running: true, daemon_version: '0.3.11', pid: 4242, busy: 2, managed: true, machine_id: 'm-1', service: true,
    hubs: [{ url: 'https://douchat.ai/agl', status: 'connected', access: 'ask', share_local: true, transport: 'http' }, { status: 'x' }, 'junk']
  }))).toEqual({ version: '0.3.12', running: true, daemonVersion: '0.3.11', pid: 4242, busy: 2, managed: true, machineId: 'm-1', service: true,
    hubs: [{ url: 'https://douchat.ai/agl', status: 'connected', transport: 'http' }] })
  expect(() => parseAglStatus('daemon: not running')).toThrow()
  expect(() => parseAglStatus('[]')).toThrow('no JSON object')
})

it('parses agl update --json', () => {
  expect(parseAglUpdate('{"current":"0.3.12","latest":"0.3.13","update_available":true,"updated":false,"busy":1}'))
    .toEqual({ current: '0.3.12', latest: '0.3.13', updateAvailable: true, updated: false, busy: 1 })
  expect(parseAglUpdate('{"current":"0.3.12","latest":"0.3.13","update_available":true,"updated":true}'))
    .toEqual({ current: '0.3.12', latest: '0.3.13', updateAvailable: true, updated: true })
})

it('finds the Douchat hub link however its URL is spelled', () => {
  expect(normalizeHubUrl('HTTPS://Douchat.AI:443/agl/')).toBe('https://douchat.ai/agl')
  const status = { hubs: [{ url: 'https://other.example/agl', status: 'connected' }, { url: 'https://douchat.ai/agl/', status: 'unauthorized' }] }
  expect(douchatHubLink(status, ['https://douchat.ai/agl'])).toEqual({ url: 'https://douchat.ai/agl/', status: 'unauthorized' })
  expect(douchatHubLink(status, ['https://douchat.ai/agl/w/team'])).toBeUndefined()
  expect(douchatHubLink({ hubs: [] }, ['https://douchat.ai/agl'])).toBeUndefined()
})
