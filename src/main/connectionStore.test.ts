import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as storeModule from './connectionStore'
import { ConnectionStore, legacyTargetId, migrateConnections, validateConnectionInput } from './connectionStore'
import { configureLocalAgentRegistry, remoteAgentPlacement } from './localAgents'

let directory = ''
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'douchat-connections-')) })
afterEach(() => { configureLocalAgentRegistry(); rmSync(directory, { recursive: true, force: true }) })

const id = (n: number) => `custom:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const legacy = (n: number, remote: Record<string, unknown>, extra: object = {}) => ({ id: id(n), name: `Agent ${n}`, command: 'codex', args: [], remote: { transport: 'ssh', adapter: 'codex', executable: 'codex', args: [], ...remote }, ...extra })
const registry = () => join(directory, 'local-agents.json')
const writeRegistry = (items: unknown[]) => writeFile(registry(), JSON.stringify(items, null, 2))
const readRegistry = async () => JSON.parse(await readFile(registry(), 'utf8'))

describe('connection store', () => {
  it('saves with mode 0600 and raises the revision only when the target changes', async () => {
    const store = new ConnectionStore(join(directory, 'connections.json'))
    const created = await store.save(validateConnectionInput({ name: 'Box', ssh: { host: 'box' } }))
    expect(statSync(store.path).mode & 0o777).toBe(0o600)
    expect(created).toMatchObject({ id: expect.stringMatching(/^conn_[0-9a-f]{32}$/), targetRevision: 0, enabled: true })
    expect((await store.save({ id: created.id, name: 'Renamed', ssh: { host: 'box' } })).targetRevision).toBe(0)
    await store.recordProbe(created.id, 0, { home: '/home/me', path: '/usr/bin', checkedAt: 1 })
    const moved = await store.save({ id: created.id, name: 'Renamed', ssh: { host: 'box', port: 2222 } })
    expect(moved.targetRevision).toBe(1)
    expect(moved.probe).toBeUndefined()
    // A probe for the old target is ignored.
    await store.recordProbe(created.id, 0, { home: '/old', path: '/usr/bin', checkedAt: 2 })
    expect((await store.get(created.id))?.probe).toBeUndefined()
    // Default port is not a change.
    expect((await store.save({ id: created.id, name: 'Renamed', ssh: { host: 'box', port: 22 } })).targetRevision).toBe(2)
    expect((await store.save({ id: created.id, name: 'Renamed', ssh: { host: 'box' } })).targetRevision).toBe(2)
  })
  it('keeps a host that follows the service running its agents itself, also when saved again', async () => {
    const store = new ConnectionStore(join(directory, 'connections.json'))
    const daemon = { hostId: 'hst_00000000-0000-4000-8000-000000000001', serviceUrl: 'https://douchat.ai', ownerId: 'u1' }
    const owner = await store.saveDaemon({ name: 'Box', daemon })
    expect(owner.daemon).toEqual(daemon)
    await store.setHostExecution(owner.id, false)
    // Switched over (the install command ran again on it): from now on it always runs its agents itself.
    const switched = await store.saveDaemon({ name: 'Box', daemon: { ...daemon, trust: 'service' } })
    expect(switched.id).toBe(owner.id)
    expect(switched.daemon).toMatchObject({ trust: 'service', hostExecution: true })
    await expect(store.setHostExecution(owner.id, false)).rejects.toThrow('always runs its agents itself')
    expect((await store.saveDaemon({ name: 'Renamed', daemon })).daemon).toMatchObject({ trust: 'service', hostExecution: true })
  })
  it('rejects malformed input and drops corrupt entries on read', async () => {
    for (const bad of [{ ssh: { host: 'a b' } }, { ssh: { host: 'box', port: 70000 } }, { ssh: { host: 'box', user: 'x;y' } }, { ssh: { host: 'box', identityFile: 'relative' } }, { ssh: { host: 'box' }, id: 'conn_x' }, { name: 'x'.repeat(81), ssh: { host: 'box' } }])
      expect(() => validateConnectionInput(bad), JSON.stringify(bad)).toThrow()
    await writeFile(join(directory, 'connections.json'), JSON.stringify({ version: 1, connections: [{ id: 'conn_bad', ssh: { host: 'x' } }, { id: `conn_${'a'.repeat(32)}`, name: 'ok', ssh: { host: 'ok' }, targetRevision: 0 }] }))
    expect((await new ConnectionStore(join(directory, 'connections.json')).list()).map(item => item.name)).toEqual(['ok'])
  })
})

describe('migration from per-agent SSH settings', () => {
  const run = async () => { const store = new ConnectionStore(join(directory, 'connections.json')); configureLocalAgentRegistry(directory, store); return { store, result: await migrateConnections(directory, store) } }

  it('groups agents by target, keeps every agent and drops the old sharing switch', async () => {
    await writeRegistry([
      legacy(1, { host: 'box', user: 'me', allowSharing: true }),
      legacy(2, { host: 'BOX', user: 'me', port: 22, adapter: 'claude', executable: 'claude' }),
      legacy(3, { host: 'other' }, { remoteTargetRevision: 2 }),
      { id: 'codex', name: 'Codex', command: '/usr/bin/codex', args: [] }
    ])
    const { store, result } = await run()
    const connections = await store.list()
    expect(connections).toHaveLength(2)
    const box = connections.find(item => item.ssh?.host === 'box')!
    expect(box).toMatchObject({ targetRevision: 0, enabled: true })
    expect(box).not.toHaveProperty('allowSharing')
    const agents = await readRegistry()
    expect(agents.find((item: any) => item.id === 'codex')).toEqual({ id: 'codex', name: 'Codex', command: '/usr/bin/codex', args: [] })
    expect(agents.every((item: any) => !item.remote)).toBe(true)
    // Sharing now lives in the agent's permissions (sharingMigration.ts).
    expect(agents.find((item: any) => item.id === id(1)).remoteAgent).toEqual({ connectionId: box.id, adapter: 'codex', executable: 'codex', args: [] })
    expect(agents.find((item: any) => item.id === id(2)).remoteAgent).toEqual({ connectionId: box.id, adapter: 'claude', executable: 'claude', args: [] })
    // Each agent keeps the P0 identity its folders and threads were saved with.
    expect((await remoteAgentPlacement(id(1)))?.target).toEqual({ executionTargetId: legacyTargetId({ host: 'box', user: 'me' }), targetRevision: 0 })
    expect((await remoteAgentPlacement(id(3)))?.target).toEqual({ executionTargetId: legacyTargetId({ host: 'other' }), targetRevision: 2 })
    expect(result[id(3)]).toMatchObject({ legacyRevision: 2 })
    // Backup of the original registry exists, and a second run changes nothing.
    expect(JSON.parse(await readFile(join(directory, 'local-agents.json.bak-before-connections'), 'utf8'))[0].remote.host).toBe('box')
    const before = await readFile(registry(), 'utf8')
    await run()
    expect(await readFile(registry(), 'utf8')).toBe(before)
    expect(await new ConnectionStore(join(directory, 'connections.json')).list()).toHaveLength(2)
  })

  it('drops the legacy identity once the connection is edited', async () => {
    await writeRegistry([legacy(1, { host: 'box' })])
    const { store } = await run()
    const [connection] = await store.list()
    await store.save({ id: connection.id, name: connection.name, ssh: { host: 'box', user: 'root' } })
    expect((await remoteAgentPlacement(id(1)))?.target).toEqual({ executionTargetId: `ssh:${connection.id}`, targetRevision: 1 })
  })

  // Writes in order: plan, connections.json, plan, local-agents.json, plan, done marker.
  it.each([[1, 'the plan'], [2, 'connections.json'], [3, 'the plan after connections'], [4, 'local-agents.json'], [5, 'the plan after agents'], [6, 'the done marker']])('resumes after a crash at write %i (%s) with the same ids and no lost agents', async failAt => {
    await writeRegistry([legacy(1, { host: 'box' }), legacy(2, { host: 'other' })])
    const store = new ConnectionStore(join(directory, 'connections.json'))
    configureLocalAgentRegistry(directory, store)
    let writes = 0
    await expect(migrateConnections(directory, store, async (path, text) => {
      if (++writes === failAt) throw new Error('simulated crash')
      return storeModule.writeAtomic(path, text)
    })).rejects.toThrow('simulated crash')
    expect(writes).toBe(failAt)
    // Never an agent that refers to a connection not yet written.
    const written = new Set((await new ConnectionStore(join(directory, 'connections.json')).list()).map(item => item.id))
    for (const agent of await readRegistry()) if (agent.remoteAgent) expect(written.has(agent.remoteAgent.connectionId)).toBe(true)
    const planned: string[] = await readFile(join(directory, 'connections-migration.json'), 'utf8').then(text => JSON.parse(text).connections.map((item: any) => item.id)).catch(() => [])

    // Restart: a fresh store reads only what is on disk.
    const restarted = new ConnectionStore(join(directory, 'connections.json'))
    configureLocalAgentRegistry(directory, restarted)
    await migrateConnections(directory, restarted)
    const agents = await readRegistry()
    expect(agents.map((item: any) => item.id)).toEqual([id(1), id(2)])
    expect(agents.every((item: any) => item.remoteAgent && !item.remote)).toBe(true)
    const ids = new Set((await restarted.list()).map(item => item.id))
    expect(ids.size).toBe(2)
    for (const agent of agents) expect(ids.has(agent.remoteAgent.connectionId)).toBe(true)
    // A plan written before the crash keeps its ids.
    for (const plannedId of planned) expect(ids.has(plannedId)).toBe(true)
    // The original settings stay recoverable.
    expect(JSON.parse(await readFile(join(directory, 'local-agents.json.bak-before-connections'), 'utf8')).map((item: any) => item.remote.host)).toEqual(['box', 'other'])
  })

  it('plans again when the registry was edited mid-migration, keeping the edit', async () => {
    await writeRegistry([legacy(1, { host: 'box' })])
    const store = new ConnectionStore(join(directory, 'connections.json'))
    configureLocalAgentRegistry(directory, store)
    // An earlier attempt got as far as writing connections, then someone edited local-agents.json.
    let writes = 0
    await expect(migrateConnections(directory, store, async (path, text) => { if (++writes === 4) throw new Error('crash'); return storeModule.writeAtomic(path, text) })).rejects.toThrow()
    const firstId = (await store.list())[0].id
    await writeRegistry([legacy(1, { host: 'box', args: ['--profile', 'x'] }), legacy(9, { host: 'new' })])
    await migrateConnections(directory, store)
    const agents = await readRegistry()
    expect(agents.find((item: any) => item.id === id(1)).remoteAgent).toMatchObject({ connectionId: firstId, args: ['--profile', 'x'] })
    expect(agents.find((item: any) => item.id === id(9)).remoteAgent.connectionId).toMatch(/^conn_/)
    expect(await store.list()).toHaveLength(2)
  })

  it('keeps agents whose old settings no longer validate, and never lets a later write delete them', async () => {
    const broken = legacy(2, { host: 'not a host' })
    await writeRegistry([legacy(1, { host: 'box' }), broken])
    const { store } = await run()
    expect(await storeModule.skippedMigrationAgents(directory)).toEqual(['Agent 2'])
    expect((await readRegistry()).find((item: any) => item.id === id(2))).toEqual(broken)
    // Adding another agent rewrites the registry; the broken entry must survive it.
    const { addCustomLocalAgent } = await import('./localAgents')
    await addCustomLocalAgent({ name: 'New', command: 'codex', remoteAgent: { connectionId: (await store.list())[0].id, adapter: 'codex', executable: 'codex', args: [] } })
    expect((await readRegistry()).find((item: any) => item.id === id(2))).toEqual(broken)
  })

  it('never deletes unmigrated agents when migration failed and the app kept running', async () => {
    await writeRegistry([legacy(1, { host: 'box' })])
    await writeFile(join(directory, 'connections.json'), '{ not json')
    const store = new ConnectionStore(join(directory, 'connections.json'))
    configureLocalAgentRegistry(directory, store)
    await expect(migrateConnections(directory, store)).rejects.toThrow()
    const { addCustomLocalAgent } = await import('./localAgents')
    await addCustomLocalAgent({ name: 'Local', command: '/bin/echo' })
    const agents = await readRegistry()
    expect(agents.find((item: any) => item.id === id(1))?.remote?.host).toBe('box')
    // Once connections.json is fixed, the next launch migrates it.
    await writeFile(join(directory, 'connections.json'), JSON.stringify({ version: 1, connections: [] }))
    const restarted = new ConnectionStore(join(directory, 'connections.json'))
    configureLocalAgentRegistry(directory, restarted)
    await migrateConnections(directory, restarted)
    expect((await readRegistry()).find((item: any) => item.id === id(1))?.remoteAgent?.connectionId).toMatch(/^conn_/)
  })

  it('is a no-op without remote agents or a registry', async () => {
    const { store } = await run()
    expect(await store.list()).toEqual([])
    await writeRegistry([{ id: 'codex', name: 'Codex', command: 'codex', args: [] }])
    const { rm } = await import('node:fs/promises')
    await rm(join(directory, 'connections-migration.done'))
    await run()
    expect(await readRegistry()).toEqual([{ id: 'codex', name: 'Codex', command: 'codex', args: [] }])
  })
})
