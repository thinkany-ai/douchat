import { describe, expect, it } from 'vitest'
import type { AppSnapshot, SnapshotPatch } from '../shared/types'
import { SnapshotPublisher, snapshotChanges } from './snapshotPublisher'

function target() {
  const sent: SnapshotPatch[] = []
  return { sent, destroyed: false, isDestroyed() { return this.destroyed }, send: (_channel: string, patch: SnapshotPatch) => { sent.push(patch) } }
}

const base = { messages: [], agents: [], userName: 'Ada', defaultConversationId: 'c1' } as unknown as AppSnapshot

describe('SnapshotPublisher', () => {
  it('sends a whole snapshot first and then only changed fields', () => {
    const publisher = new SnapshotPublisher<ReturnType<typeof target>>('snap')
    const window = target()
    publisher.publish([window], base)
    expect(window.sent).toEqual([{ full: true, values: base }])
    publisher.publish([window], { ...base })
    expect(window.sent).toHaveLength(1)
    const messages = [{ id: 'm' }] as unknown as AppSnapshot['messages']
    publisher.publish([window], { ...base, messages })
    expect(window.sent[1]).toEqual({ full: false, values: { messages } })
  })

  it('builds on the snapshot a window asked for directly', () => {
    const publisher = new SnapshotPublisher<ReturnType<typeof target>>('snap')
    const window = target()
    const asked = { ...base, userName: 'Grace' }
    publisher.reset(window, asked)
    publisher.publish([window], asked)
    expect(window.sent).toEqual([])
  })

  it('skips destroyed windows', () => {
    const publisher = new SnapshotPublisher<ReturnType<typeof target>>('snap')
    const window = target()
    window.destroyed = true
    publisher.publish([window], base)
    expect(window.sent).toEqual([])
  })
})

describe('snapshotChanges', () => {
  it('reports removed optional fields as undefined', () => {
    const { defaultConversationId: _, ...rest } = base
    const changes = snapshotChanges(base, rest as AppSnapshot)
    expect(Object.keys(changes)).toEqual(['defaultConversationId'])
    expect(changes.defaultConversationId).toBeUndefined()
  })
})
