import { describe, expect, it } from 'vitest'
import { replaceEqualDeep } from './structuralSharing'

describe('replaceEqualDeep', () => {
  it('returns the previous value when nothing changed', () => {
    const previous = { messages: [{ id: 'a', text: 'hi', tags: ['x'] }], count: 1 }
    const next = structuredClone(previous)
    expect(replaceEqualDeep(previous, next)).toBe(previous)
  })

  it('keeps unchanged siblings and replaces only the changed path', () => {
    const previous = { messages: [{ id: 'a', text: 'hi' }, { id: 'b', text: 'yo' }], agents: [{ id: 'x' }] }
    const next = structuredClone(previous)
    next.messages[1].text = 'yo!'
    const result = replaceEqualDeep(previous, next)
    expect(result).not.toBe(previous)
    expect(result).toEqual(next)
    expect(result.agents).toBe(previous.agents)
    expect(result.messages).not.toBe(previous.messages)
    expect(result.messages[0]).toBe(previous.messages[0])
    expect(result.messages[1]).not.toBe(previous.messages[1])
  })

  it('reuses items when an array grows', () => {
    const previous = [{ id: 'a' }]
    const next = [{ id: 'a' }, { id: 'b' }]
    const result = replaceEqualDeep(previous, next)
    expect(result).toHaveLength(2)
    expect(result[0]).toBe(previous[0])
  })

  it('notices removed and added keys', () => {
    expect(replaceEqualDeep({ a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1 })
    const previous = { a: 1 }
    const result = replaceEqualDeep(previous, { a: 1, b: undefined })
    expect(result).not.toBe(previous)
    expect('b' in result).toBe(true)
  })

  it('handles null previous and non-plain values', () => {
    const next = { at: new Date(0) }
    expect(replaceEqualDeep(null, next)).toBe(next)
    const bytes = { data: new Uint8Array([1]) }
    expect(replaceEqualDeep({ data: new Uint8Array([1]) }, bytes).data).toBe(bytes.data)
  })
})
