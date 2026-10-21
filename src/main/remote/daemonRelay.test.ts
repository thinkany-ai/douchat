import { expect, it, vi } from 'vitest'
import { RelayStream } from './daemonRelay'

it('batches adjacent protocol writes and EOF in order without an extra send', async () => {
  const call = vi.fn(async () => ({}))
  const stream = new RelayStream({ call, forget: vi.fn() } as never, 'test-stream', 'test-host')
  stream.send('in', Buffer.from('initialized\n'))
  stream.send('in', Buffer.from('thread/start\n'))
  stream.send('eof')
  expect(call).not.toHaveBeenCalled()
  await new Promise(resolve => setImmediate(resolve))
  expect(call).toHaveBeenCalledOnce()
  expect(call.mock.calls[0]).toEqual([{
    action: 'relay-send', streamId: 'test-stream',
    frames: [
      { seq: 1, type: 'in', data: Buffer.from('initialized\nthread/start\n').toString('base64') },
      { seq: 2, type: 'eof' }
    ]
  }])
})

it('sends a kill immediately even when a protocol batch is scheduled', async () => {
  const call = vi.fn(async () => ({}))
  const stream = new RelayStream({ call, forget: vi.fn() } as never, 'test-stream', 'test-host')
  stream.send('in', Buffer.from('pending'))
  stream.close()
  await new Promise(resolve => setImmediate(resolve))
  expect(call).toHaveBeenCalledOnce()
  expect(call.mock.calls[0]).toEqual([{
    action: 'relay-send', streamId: 'test-stream', frames: [{ seq: 1, type: 'kill' }]
  }])
})
