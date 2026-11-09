import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const publishScript = fileURLToPath(new URL('./publish-release.sh', import.meta.url))

async function publish(failHead = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'douchat-publish-test-'))
  const files = {
    'latest-mac.yml': JSON.stringify({ version: '0.1.29', files: ['arm64', 'x64'].map(arch => ({ url: `Douchat-0.1.29-mac-${arch}.dmg` })) }),
    'latest.yml': JSON.stringify({ version: '0.1.27', files: [{ url: 'Douchat-0.1.27-win-x64.exe' }] }),
    'latest-linux.yml': JSON.stringify({ version: '0.1.26', files: [{ url: 'Douchat-0.1.26-linux-x86_64.AppImage' }, { url: 'Douchat-0.1.26-linux-amd64.deb' }] }),
    'Douchat-0.1.29-mac-arm64.dmg': 'fixture installer',
  }
  try {
    for (const [name, body] of Object.entries(files)) await writeFile(path.join(directory, name), body)
    const mock = `#!/usr/bin/env node
const fs=require('fs'),path=require('path');const args=process.argv.slice(2),dir=process.env.FIXTURE_DIR;
if(path.basename(process.argv[1])==='aws'){
 fs.appendFileSync(path.join(dir,'uploads.jsonl'),JSON.stringify(args)+'\\n');
 if(args[3].endsWith('/latest.json'))fs.copyFileSync(args[2],path.join(dir,'published.json'));
}else{
 if(args.includes('--head')){if(process.env.FAIL_HEAD==='1')process.exit(22);process.exit(0)}
 const url=args.find(a=>a.startsWith('https://'));fs.copyFileSync(path.join(dir,path.basename(url)),args[args.indexOf('-o')+1]);
}
`
    for (const name of ['aws', 'curl']) {
      await writeFile(path.join(directory, name), mock)
      await chmod(path.join(directory, name), 0o755)
    }
    const result = spawnSync('bash', [publishScript, path.join(directory, 'Douchat-0.1.29-mac-arm64.dmg'), path.join(directory, 'latest-mac.yml')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, FIXTURE_DIR: directory, FAIL_HEAD: failHead ? '1' : '0',
        CLOUDFLARE_ACCOUNT_ID: 'test-account', AWS_ACCESS_KEY_ID: 'test-key', AWS_SECRET_ACCESS_KEY: 'test-not-a-real-secret' },
    })
    const uploads = (await readFile(path.join(directory, 'uploads.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const catalog = failHead ? null : JSON.parse(await readFile(path.join(directory, 'published.json'), 'utf8'))
    return { result, uploads, catalog }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('partial Mac publish keeps other platforms and advertises latest.json last, without touching the legacy feed', async () => {
  const { result, uploads, catalog } = await publish()
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(uploads.map(args => args[3]), [
    's3://douchat/thinkany/Douchat-0.1.29-mac-arm64.dmg',
    's3://douchat/thinkany/latest-mac.yml',
    's3://douchat/latest.json',
  ])
  assert.equal(catalog.platforms.windows.version, '0.1.27')
  assert.equal(catalog.platforms.linux.version, '0.1.26')
  assert.equal(uploads.at(-1)[uploads.at(-1).indexOf('--cache-control') + 1], 'no-store, max-age=0')
})

test('unreachable installer blocks publication of the website catalog', async () => {
  const { result, uploads } = await publish(true)
  assert.notEqual(result.status, 0)
  assert.equal(uploads.some(args => args[3] === 's3://douchat/latest.json'), false)
})
