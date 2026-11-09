import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateDownloadCatalog } from './generate-download-catalog.mjs'

function feeds() {
  return {
    mac: { version: '0.1.29', files: ['arm64', 'x64'].map(arch => ({ url: `Douchat-0.1.29-mac-${arch}.dmg` })) },
    windows: { version: '0.1.27', files: [{ url: 'Douchat-0.1.27-win-x64.exe' }] },
    linux: { version: '0.1.26', files: [{ url: 'Douchat-0.1.26-linux-x86_64.AppImage' }, { url: 'Douchat-0.1.26-linux-amd64.deb' }] }
  }
}

test('retains per-platform versions and routes Mac downloads to the ThinkAny namespace', () => {
  const result = generateDownloadCatalog(feeds())
  assert.equal(result.platforms.mac.version, '0.1.29')
  assert.equal(result.platforms.mac.downloads.arm64, 'https://cdn.douchat.ai/thinkany/Douchat-0.1.29-mac-arm64.dmg')
  assert.equal(result.platforms.windows.version, '0.1.27')
  assert.equal(result.platforms.linux.version, '0.1.26')
  assert.equal(result.platforms.windows.downloads.x64, 'https://cdn.douchat.ai/Douchat-0.1.27-win-x64.exe')
})

test('refuses incomplete releases instead of publishing a missing installer', () => {
  const input = feeds()
  input.mac.files.pop()
  assert.throws(() => generateDownloadCatalog(input), /Missing installer/)
})

test('rejects external installer links and invalid versions', () => {
  const input = feeds()
  input.mac.files[0].url = 'https://evil.example/Douchat-0.1.29-mac-arm64.dmg'
  assert.throws(() => generateDownloadCatalog(input), /Invalid installer URL/)
  input.mac.version = 'not-a-version'
  assert.throws(() => generateDownloadCatalog(input), /Invalid release version/)
})
