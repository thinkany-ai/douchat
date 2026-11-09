import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hostTarget, parseArgs, parseChecksum, pinnedVersion, sha256 } from './fetch-agl.mjs'

test('maps platforms to agl release targets, with nothing for Windows', () => {
  assert.equal(hostTarget('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(hostTarget('darwin', 'x64'), 'darwin-x64')
  assert.equal(hostTarget('linux', 'x64'), 'linux-x64')
  assert.equal(hostTarget('linux', 'arm64'), 'linux-arm64')
  assert.equal(hostTarget('win32', 'x64'), undefined)
  assert.deepEqual(parseArgs(['--platform', 'mac']).targets, ['darwin-arm64', 'darwin-x64'])
  assert.deepEqual(parseArgs(['--platform', 'win']).targets, [])
  assert.deepEqual(parseArgs(['--targets', 'linux-x64', '--release']), { release: true, targets: ['linux-x64'] })
  assert.throws(() => parseArgs(['--targets', 'windows-x64']), /unknown agl target/)
})

test('reads the first sha256 token and rejects anything else', () => {
  const digest = sha256(Buffer.from('agl'))
  assert.equal(parseChecksum(`${digest}  agl-darwin-arm64\n`), digest)
  assert.equal(parseChecksum(digest.toUpperCase()), digest)
  assert.throws(() => parseChecksum('<html>Not Found</html>'), /no sha256/)
})

test('pins the version in package.json, overridable by DOUCHAT_AGL_VERSION', async () => {
  assert.match(await pinnedVersion(), /^\d+\.\d+\.\d+$/)
  process.env.DOUCHAT_AGL_VERSION = 'v0.4.0'
  try { assert.equal(await pinnedVersion(), '0.4.0') } finally { delete process.env.DOUCHAT_AGL_VERSION }
})
