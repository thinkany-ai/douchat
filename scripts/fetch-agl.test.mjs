import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchAgl, hostTarget, parseArgs, parseChecksum, pinnedVersion, sha256, strictBuild } from './fetch-agl.mjs'

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

test('is strict only for release builds', () => {
  assert.equal(strictBuild({ release: true }, {}), true)
  assert.equal(strictBuild({ release: false }, { npm_lifecycle_event: 'release:mac' }), true)
  assert.equal(strictBuild({ release: false }, { npm_lifecycle_event: 'package:mac' }), false)
  assert.equal(strictBuild({ release: false }, { npm_lifecycle_event: 'package' }), false)
  assert.equal(strictBuild({ release: false }, {}), false)
})

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'fetch-agl-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ agl: { version: '0.3.12' } }))
  return root
}
const exists = (path) => stat(path).then(() => true, () => false)
const quiet = { log: () => {}, warn: () => {} }
const binary = Buffer.from('agl-binary')
const serve = (files) => async (url) => {
  const name = url.split('/').pop()
  if (!(name in files)) throw new Error(`download ${url}: HTTP 404 (is this agl version released?)`)
  return Buffer.from(files[name])
}

test('places a verified download', async () => {
  const root = await project()
  try {
    const skipped = await fetchAgl(['--targets', 'linux-arm64'], { root, env: {}, ...quiet, fetchBytes: serve({ 'agl-linux-arm64': binary, 'agl-linux-arm64.sha256': `${sha256(binary)}  agl-linux-arm64\n` }) })
    assert.deepEqual(skipped, [])
    assert.deepEqual(await readFile(join(root, 'resources/bin/linux-arm64/agl')), binary)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('outside a release, a failed download or bad checksum warns and builds without agl, removing a stale one', async () => {
  const root = await project()
  try {
    // An older agl left from an earlier build must not ship by accident.
    await mkdir(join(root, 'resources/bin/linux-x64'), { recursive: true })
    await writeFile(join(root, 'resources/bin/linux-x64/agl'), 'old agl')
    const warnings = []
    const skipped = await fetchAgl(['--targets', 'linux-x64,linux-arm64'], { root, env: { npm_lifecycle_event: 'package:linux' }, log: () => {}, warn: (line) => warnings.push(line),
      fetchBytes: serve({ 'agl-linux-arm64': binary, 'agl-linux-arm64.sha256': '0'.repeat(64) }) })
    assert.deepEqual(skipped, ['linux-x64', 'linux-arm64'])
    assert.equal(await exists(join(root, 'resources/bin/linux-x64/agl')), false)
    assert.equal(await exists(join(root, 'resources/bin/linux-arm64/agl')), false)
    assert.match(warnings.join('\n'), /HTTP 404/)
    assert.match(warnings.join('\n'), /checksum mismatch/)
    assert.match(warnings.join('\n'), /building without a bundled agl for linux-x64/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a release build fails on a missing download or bad checksum, and refuses DOUCHAT_AGL_BIN', async () => {
  const root = await project()
  try {
    await assert.rejects(fetchAgl(['--targets', 'linux-x64'], { root, env: { npm_lifecycle_event: 'release:linux' }, ...quiet, fetchBytes: serve({}) }), /HTTP 404/)
    await assert.rejects(fetchAgl(['--targets', 'linux-x64', '--release'], { root, env: {}, ...quiet,
      fetchBytes: serve({ 'agl-linux-x64': binary, 'agl-linux-x64.sha256': '0'.repeat(64) }) }), /checksum mismatch/)
    assert.equal(await exists(join(root, 'resources/bin/linux-x64/agl')), false)
    await assert.rejects(fetchAgl(['--release'], { root, env: { DOUCHAT_AGL_BIN: '/tmp/agl' }, ...quiet }), /DOUCHAT_AGL_BIN is for development builds/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
