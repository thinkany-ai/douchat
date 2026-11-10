import { describe, expect, it } from 'vitest'
import { ATTACHMENT_LIMITS, base64ToBytes, bytesToBase64 } from './attachments'
import { directSessionKey, hostSessionKey, packTaskInputs } from './hostTask'

const bytes = (size: number, fill = 1) => new Uint8Array(size).fill(fill)

describe('host task inputs', () => {
  it('encodes base64 like Node, across chunk boundaries', () => {
    const data = Uint8Array.from({ length: 0x8000 * 2 + 7 }, (_, index) => index % 256)
    expect(bytesToBase64(data)).toBe(Buffer.from(data).toString('base64'))
    expect([...base64ToBytes(bytesToBase64(data))]).toEqual([...data])
  })

  it('keeps what fits the message limits, in order', () => {
    const inputs = packTaskInputs(
      [
        { name: 'a.png', mimeType: 'image/png', data: bytes(3) },
        { name: 'b.svg', mimeType: 'image/svg+xml', data: bytes(3) },
        { name: 'big.png', mimeType: 'image/png', data: bytes(ATTACHMENT_LIMITS.imageBytes + 1) }
      ],
      [
        { name: 'one.txt', data: bytes(2) },
        { name: 'empty.txt', data: bytes(0) },
        { name: 'two.txt', data: bytes(2) },
        { name: 'three.txt', data: bytes(2) },
        { name: 'four.txt', data: bytes(2) }
      ]
    )
    expect(inputs.images?.map(image => image.name)).toEqual(['a.png'])
    expect(inputs.images?.[0].base64).toBe(Buffer.from(bytes(3)).toString('base64'))
    expect(inputs.files?.map(file => file.name)).toEqual(['one.txt', 'two.txt', 'three.txt'])
  })

  it('stops at the total size', () => {
    const half = ATTACHMENT_LIMITS.totalBytes / 2
    const inputs = packTaskInputs([], [{ name: 'a', data: bytes(half) }, { name: 'b', data: bytes(half + 1) }, { name: 'c', data: bytes(half) }])
    expect(inputs.files?.map(file => file.name)).toEqual(['a', 'c'])
    expect(packTaskInputs()).toEqual({})
  })

  it('builds one session key for the desktop and the web app', () => {
    expect(hostSessionKey(directSessionKey('c1', 't1'))).toBe('direct:c1:t1:')
    expect(hostSessionKey(directSessionKey('c1', 't1'), 'reset-1')).toBe('direct:c1:t1:reset-1')
  })
})
