import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PROMPT_ARG, REMOTE_BOOTSTRAP, beginTurnScript, cleanupScript, customRemoteArguments, encodePayload, framesScript, killScript, launchScript,
  listDirectoriesScript, markPromptArguments, prepareScript, probeScript, resolveDirectoryScript, runDirectory, uploadScript
} from './remoteScript'
import { realpath, rename } from 'node:fs/promises'
import { parseFrames, OUTBOX_LIMITS } from './remoteFileChannel'
import { parseRemoteProbe } from './remoteValidate'

const SHELLS = ['/bin/sh', '/bin/bash', '/bin/zsh', '/bin/dash', '/bin/ksh'].filter(shell => existsSync(shell))
const PROMPT = "hi $(touch pwned) `touch pwned2` ${HOME} 'q' \"dq\" \\ ; | & * ~ !\n中文🙂\n\n"

let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'douchat-remote-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

/** What sshd does: `$SHELL -c "<remote command>"` with the joined arguments. */
function remote(script: string, options: { input?: string | Buffer; shell?: string } = {}) {
  const command = `${REMOTE_BOOTSTRAP} ${encodePayload(script)}`
  return spawnSync(options.shell ?? '/bin/sh', ['-c', command], {
    cwd: home, input: options.input ?? '', env: { PATH: '/usr/bin:/bin', HOME: home, SHELL: options.shell ?? '/bin/sh' }
  })
}

describe('bootstrap', () => {
  it('only puts base64 text after the fixed command', () => {
    const payload = encodePayload(launchScript({ runId: randomUUID(), executable: 'codex', args: ['exec', '-'], channel: 'stdin' }))
    expect(payload).toMatch(/^[A-Za-z0-9+/=]+$/)
  })

  it('decodes and runs the payload identically in every login shell', () => {
    for (const shell of SHELLS) {
      const result = remote(`printf '%s' 'ok $x'\n`, { shell })
      expect(result.status, shell).toBe(0)
      expect(result.stdout.toString(), shell).toBe('ok $x')
    }
  })
})

describe('run directory lifecycle', () => {
  it('prepares a turn in one script, clears only its outbox and rejects linked outboxes', async () => {
    const runId = randomUUID()
    expect(remote(prepareScript(runId)).status).toBe(0)
    const directory = join(home, '.douchat-remote', `t-${runId}`)
    const outside = join(home, 'project')
    await mkdir(outside)
    await writeFile(join(outside, 'keep.txt'), 'keep')
    await writeFile(join(directory, 'out', 'old.txt'), 'old')
    await writeFile(join(directory, '.marker'), 'old marker')
    expect(remote(beginTurnScript(runId)).status).toBe(0)
    expect(await readFile(join(directory, '.marker'), 'utf8')).toBe('')
    expect(existsSync(join(directory, 'out', 'old.txt'))).toBe(false)
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
    await rm(join(directory, 'out'), { recursive: true })
    await symlink(outside, join(directory, 'out'))
    expect(remote(beginTurnScript(runId)).status).not.toBe(0)
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })
  it('prepares, uploads, launches with the prompt only on stdin, and cleans up', async () => {
    const runId = randomUUID()
    expect(remote(prepareScript(runId)).status).toBe(0)
    const directory = join(home, '.douchat-remote', `t-${runId}`)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect(remote(prepareScript(runId)).status).not.toBe(0)

    const image = Buffer.from([137, 80, 78, 71, 0, 10, 13, 255])
    const upload = remote(uploadScript(runId, 'img.png', image.length), { input: image })
    expect(upload.status).toBe(0)
    expect(upload.stdout.toString().trim()).toBe(String(image.length))
    expect(await readFile(join(directory, 'img.png'))).toEqual(image)
    expect(remote(uploadScript(runId, 'img.png', 1), { input: 'x' }).status).not.toBe(0)
    expect(() => uploadScript(runId, '../x', 1)).toThrow()
    expect(() => uploadScript(runId, '.hidden', 1)).toThrow()
    expect(() => uploadScript('../../etc', 'a', 1)).toThrow()

    const cwd = join(directory, 'work')
    expect((await stat(cwd)).mode & 0o777).toBe(0o700)
    const argv = launchScript({ runId, executable: '/usr/bin/printf', args: ['%s', PROMPT_ARG], channel: 'argv' })
    expect(argv).not.toContain('touch pwned')
    const result = remote(argv, { input: PROMPT })
    expect(result.status, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString()).toBe(PROMPT)
    expect(existsSync(join(cwd, 'pwned'))).toBe(false)
    expect(existsSync(join(home, 'pwned'))).toBe(false)
    expect((await readFile(join(directory, 'pid'), 'utf8'))).toMatch(/^\d+$/)

    const stdin = remote(launchScript({ runId, executable: 'cat', args: [], channel: 'stdin' }), { input: PROMPT })
    expect(stdin.stdout.toString()).toBe(PROMPT)

    await writeFile(join(directory, 'pid'), '1')
    expect(remote(killScript(runId)).status).toBe(0)
    await writeFile(join(directory, 'pid'), '$(touch pwned3)')
    expect(remote(killScript(runId)).status).toBe(0)
    expect(existsSync(join(home, 'pwned3'))).toBe(false)

    expect(remote(cleanupScript(runId)).status).toBe(0)
    expect(existsSync(directory)).toBe(false)
  })

  it('refuses a symlinked root or run directory', async () => {
    const target = await mkdtemp(join(tmpdir(), 'douchat-target-'))
    try {
      await symlink(target, join(home, '.douchat-remote'))
      expect(remote(prepareScript(randomUUID())).status).not.toBe(0)
      await rm(join(home, '.douchat-remote'))
      const runId = randomUUID()
      await mkdir(join(home, '.douchat-remote'))
      await symlink(target, join(home, '.douchat-remote', `t-${runId}`))
      expect(remote(uploadScript(runId, 'a.txt', 1), { input: 'x' }).status).not.toBe(0)
      expect(existsSync(join(target, 'a.txt'))).toBe(false)
    } finally { await rm(target, { recursive: true, force: true }) }
  })

  it('substitutes custom {prompt} arguments without placing the prompt in the script', async () => {
    const runId = randomUUID()
    remote(prepareScript(runId))
    const args = customRemoteArguments(['%s|%s', 'a{prompt}b', '{prompt}'])
    const script = launchScript({ runId, executable: 'printf', args, channel: 'argv' })
    const result = remote(script, { input: 'X$(id)' })
    expect(result.stdout.toString()).toBe('aX$(id)b|X$(id)')
    expect(customRemoteArguments(['-q'])).toEqual(['-q', PROMPT_ARG])
    expect(markPromptArguments(['-p', 'secret'], 'secret')).toEqual(['-p', PROMPT_ARG])
    expect(() => launchScript({ runId, executable: 'printf', args: [PROMPT_ARG], channel: 'stdin' })).toThrow()
    expect(() => launchScript({ runId, executable: 'a;b', args: [], channel: 'stdin' })).toThrow()
    expect(() => launchScript({ runId, workspace: { key: '../x' }, executable: 'printf', args: [], channel: 'stdin' })).toThrow()
  })
})

describe('framesScript', () => {
  it('returns only regular, single-link, safely named files in one level', async () => {
    const directory = join(home, 'out')
    const outside = join(home, 'secret.txt')
    await mkdir(directory)
    await writeFile(outside, 'secret')
    await writeFile(join(directory, 'report.txt'), 'hello\n')
    await writeFile(join(directory, '.hidden'), 'x')
    await writeFile(join(directory, 'bad name.txt'), 'x')
    await writeFile(join(directory, 'empty.txt'), '')
    await symlink(outside, join(directory, 'link.txt'))
    await link(outside, join(directory, 'hard.txt'))
    await mkdir(join(directory, 'sub'))
    await writeFile(join(directory, 'sub', 'deep.txt'), 'x')
    const result = remote(framesScript({ directory: `"$HOME"/'out'`, ...OUTBOX_LIMITS }))
    expect(result.status).toBe(0)
    const frames = parseFrames(result.stdout, OUTBOX_LIMITS)
    expect(frames.map(frame => [frame.name, frame.data.toString()])).toEqual([['report.txt', 'hello\n']])

    await rm(join(directory, 'link.txt'))
    await rm(directory, { recursive: true })
    await symlink(home, directory)
    expect(parseFrames(remote(framesScript({ directory: `"$HOME"/'out'`, ...OUTBOX_LIMITS })).stdout, OUTBOX_LIMITS)).toEqual([])
  })

  it('stops at the file count limit and respects the run marker', async () => {
    const runId = randomUUID()
    remote(prepareScript(runId))
    const out = join(home, '.douchat-remote', `t-${runId}`, 'out')
    for (let index = 0; index < 5; index++) await writeFile(join(out, `f${index}.txt`), 'x')
    const limited = remote(framesScript({ directory: `${runDirectory(runId)}/out`, maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 100 }))
    expect(parseFrames(limited.stdout, { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 100 })).toHaveLength(2)
    const newer = remote(framesScript({ directory: `${runDirectory(runId)}/out`, newerThanRun: runId, ...OUTBOX_LIMITS }))
    expect(newer.status).toBe(0)
  })
})

describe('probeScript', () => {
  it('resolves an executable and the remote home', () => {
    const result = remote(probeScript('sh'))
    const probe = parseRemoteProbe(result.stdout.toString())
    expect(probe.executable).toMatch(/\/sh$/)
    expect(probe.remoteHome).toBe(home.replace(/\/$/, ''))
    expect(() => probeScript('sh;id')).toThrow()
  })

  async function fakeCli(directory: string, name = 'fakecli'): Promise<string> {
    await mkdir(directory, { recursive: true })
    const file = join(directory, name)
    await writeFile(file, '#!/bin/sh\necho fake\n', { mode: 0o755 })
    return file
  }

  it.skipIf(!existsSync('/bin/zsh'))('finds a CLI that only ~/.zshrc adds to PATH, ignoring rc banners and escape codes', async () => {
    const cli = await fakeCli(join(home, 'only-in-zshrc'))
    await writeFile(join(home, '.zshrc'), `printf '\\033]1337;RemoteHost=x\\007 welcome banner\\n'\nexport PATH="${join(home, 'only-in-zshrc')}:$PATH"\n`)
    const result = spawnSync('/bin/sh', ['-c', `${REMOTE_BOOTSTRAP} ${encodePayload(probeScript('fakecli'))}`], {
      cwd: home, input: '', env: { PATH: '/usr/bin:/bin', HOME: home, ZDOTDIR: home, SHELL: '/bin/zsh' }
    })
    const probe = parseRemoteProbe(result.stdout.toString())
    expect(probe.executable).toBe(cli)
    expect(probe.remotePath.split(':')[0]).toBe(join(home, 'only-in-zshrc'))
  })

  it('falls back to the newest nvm bin and puts it first so node is found next to the CLI', async () => {
    await fakeCli(join(home, '.nvm/versions/node/v18.0.0/bin'))
    const newest = await fakeCli(join(home, '.nvm/versions/node/v24.1.0/bin'))
    const probe = parseRemoteProbe(remote(probeScript('fakecli')).stdout.toString())
    expect(probe.executable).toBe(newest)
    expect(probe.remotePath.split(':')[0]).toBe(join(home, '.nvm/versions/node/v24.1.0/bin'))
  })

  it('does not trust PATH text a login shell prints outside the markers', async () => {
    await writeFile(join(home, '.profile'), 'echo "DOUCHAT_PATH_0000000000000000_BEGIN/evil DOUCHAT_PATH_0000000000000000_END"\nprintf "relative:dir\\n"\n')
    const result = remote(probeScript('sh', '1111111111111111'))
    const probe = parseRemoteProbe(result.stdout.toString())
    expect(probe.remotePath).not.toContain('/evil')
    expect(() => probeScript('sh', 'not-a-nonce')).toThrow()
  })
})

describe('conversation workspace', () => {
  const key = 'a'.repeat(64)
  it('stops the previous run of the same conversation, including a launcher child, before a new run starts', async () => {
    const first = randomUUID()
    expect(remote(prepareScript(first, { key })).status).toBe(0)
    const old = spawn('/bin/sh', ['-c', `${REMOTE_BOOTSTRAP} ${encodePayload(launchScript({ runId: first, workspace: { key }, executable: 'sh', args: ['-c', 'sleep 300 & wait'], channel: 'none' }))}`], {
      cwd: home, env: { PATH: '/usr/bin:/bin', HOME: home }, detached: true, stdio: 'ignore'
    })
    old.unref()
    const exited = new Promise(resolve => old.once('exit', resolve))
    const pidFile = join(home, '.douchat-remote', `t-${first}`, 'pid')
    for (let i = 0; i < 50 && !existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 20))
    await new Promise(resolve => setTimeout(resolve, 200))
    const pid = Number(await readFile(pidFile, 'utf8'))
    const child = Number(spawnSync('/bin/sh', ['-c', `ps -eo pid=,ppid= | awk '$2 == ${pid} { print $1 }'`]).stdout.toString().trim())
    expect(child).toBeGreaterThan(1)

    // The old agent is our own child here, so it lingers as a zombie until
    // node reaps it; sshd reaps it on a server. Stop the reaper-induced wait.
    const second = randomUUID()
    const started = Date.now()
    const takeover = new Promise<number | null>(resolve => {
      const next = spawn('/bin/sh', ['-c', `${REMOTE_BOOTSTRAP} ${encodePayload(prepareScript(second, { key }))}`], { cwd: home, env: { PATH: '/usr/bin:/bin', HOME: home } })
      next.once('exit', resolve)
    })
    await exited
    expect(await takeover).toBe(0)
    expect(Date.now() - started).toBeLessThan(4000)
    const alive = (value: number) => { try { process.kill(value, 0); return true } catch { return false } }
    expect(old.exitCode !== null || old.signalCode !== null).toBe(true)
    expect(alive(child)).toBe(false)
    expect(alive(pid)).toBe(false)
    expect(existsSync(join(home, '.douchat-remote', `t-${first}`))).toBe(false)
    expect(await readFile(join(home, '.douchat-remote', 'w', `${key}.run`), 'utf8')).toBe(`t-${second}`)
  })

  it('ignores a forged owner record instead of deleting or signalling outside the run folders', async () => {
    const victim = await mkdtemp(join(home, 'victim-'))
    const first = randomUUID()
    expect(remote(prepareScript(first, { key })).status).toBe(0)
    for (const forged of ['../victim', `t-${first}/../../${victim.split('/').pop()}`, '$(touch pwned)', 't-zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz']) {
      await writeFile(join(home, '.douchat-remote', 'w', `${key}.run`), forged)
      expect(remote(prepareScript(randomUUID(), { key })).status).toBe(0)
    }
    expect(existsSync(victim)).toBe(true)
    expect(existsSync(join(home, 'pwned'))).toBe(false)
    await writeFile(join(home, '.douchat-remote', `t-${first}`, 'pid'), '1')
    await writeFile(join(home, '.douchat-remote', 'w', `${key}.run`), `t-${first}`)
    expect(remote(prepareScript(randomUUID(), { key })).status).toBe(0)
  })
  it('creates a private folder named by Douchat and reuses it across runs', async () => {
    const first = randomUUID()
    expect(remote(prepareScript(first, { key })).status).toBe(0)
    const folder = join(home, '.douchat-remote', 'w', key)
    expect((await stat(folder)).mode & 0o777).toBe(0o700)
    const pwd = remote(launchScript({ runId: first, workspace: { key }, executable: 'pwd', args: [], channel: 'none' }))
    expect(pwd.stdout.toString().trim()).toMatch(new RegExp(`/\\.douchat-remote/w/${key}$`))
    await writeFile(join(folder, 'keep.txt'), 'x')
    const second = randomUUID()
    expect(remote(prepareScript(second, { key })).status).toBe(0)
    expect(existsSync(join(folder, 'keep.txt'))).toBe(true)
  })

  it('rejects invalid keys and symlinked workspace folders', async () => {
    for (const bad of ['../../etc', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(63)}/`, "a'$(id)"]) {
      expect(() => prepareScript(randomUUID(), { key: bad }), bad).toThrow()
      expect(() => launchScript({ runId: randomUUID(), workspace: { key: bad }, executable: 'pwd', args: [], channel: 'none' }), bad).toThrow()
    }
    const target = await mkdtemp(join(tmpdir(), 'douchat-target-'))
    try {
      await mkdir(join(home, '.douchat-remote', 'w'), { recursive: true })
      await symlink(target, join(home, '.douchat-remote', 'w', key))
      expect(remote(prepareScript(randomUUID(), { key })).status).not.toBe(0)
      await rm(join(home, '.douchat-remote', 'w'), { recursive: true })
      await symlink(target, join(home, '.douchat-remote', 'w'))
      expect(remote(prepareScript(randomUUID(), { key })).status).not.toBe(0)
      expect(existsSync(join(target, key))).toBe(false)
    } finally { await rm(target, { recursive: true, force: true }) }
  })
})

describe('chosen server folder', () => {
  const key = 'b'.repeat(64)
  it('runs in the chosen folder in place, keeps the run owner record, and leaves the folder alone on cleanup', async () => {
    const project = await realpath(await mkdtemp(join(home, 'project-')))
    await writeFile(join(project, 'keep.txt'), 'x')
    const runId = randomUUID()
    expect(remote(prepareScript(runId, { key, path: project })).status).toBe(0)
    // No managed folder is created for a chosen one; the owner record still is.
    expect(existsSync(join(home, '.douchat-remote', 'w', key))).toBe(false)
    expect(await readFile(join(home, '.douchat-remote', 'w', `${key}.run`), 'utf8')).toBe(`t-${runId}`)
    const pwd = remote(launchScript({ runId, workspace: { key, path: project }, executable: 'pwd', args: [], channel: 'none' }))
    expect(pwd.status).toBe(0)
    expect(pwd.stdout.toString().trim()).toBe(project)
    expect(remote(cleanupScript(runId)).status).toBe(0)
    expect(await readFile(join(project, 'keep.txt'), 'utf8')).toBe('x')
    expect((await stat(project)).mode & 0o777).not.toBe(0)
  })

  it('refuses to launch when the saved folder was replaced by a symbolic link or removed', async () => {
    const project = await realpath(await mkdtemp(join(home, 'project-')))
    const elsewhere = await realpath(await mkdtemp(join(home, 'elsewhere-')))
    const runId = randomUUID()
    expect(remote(prepareScript(runId, { key, path: project })).status).toBe(0)
    await rename(project, `${project}.moved`)
    await symlink(elsewhere, project)
    const swapped = remote(launchScript({ runId, workspace: { key, path: project }, executable: 'pwd', args: [], channel: 'none' }))
    expect(swapped.status).not.toBe(0)
    expect(swapped.stderr.toString()).toContain('was replaced')
    expect(swapped.stdout.toString()).toBe('')
    await rm(project)
    expect(remote(prepareScript(randomUUID(), { key, path: project })).status).not.toBe(0)
  })

  it('rejects malformed folder paths before anything runs', () => {
    for (const bad of ['relative', '/a/../b', '/a/./b', '/a//b', '/a/', `/a\nb`, '/a\u0000b', '/' + 'x'.repeat(1100)]) {
      expect(() => launchScript({ runId: randomUUID(), workspace: { path: bad }, executable: 'pwd', args: [], channel: 'none' }), bad).toThrow()
      expect(() => listDirectoriesScript(bad), bad).toThrow()
      expect(() => resolveDirectoryScript(bad), bad).toThrow()
    }
  })

  it('treats hostile folder names as data in every shell', async () => {
    const project = await realpath(await mkdtemp(join(home, 'project-')))
    const hostile = join(project, "it's $(touch pwned) `id` ; ok")
    await mkdir(hostile)
    for (const shell of SHELLS) {
      const result = remote(resolveDirectoryScript(hostile), { shell })
      expect(result.status, shell).toBe(0)
      expect(result.stdout.toString().trim().split('\n').at(-1), shell).toBe(hostile)
    }
    expect(existsSync(join(home, 'pwned'))).toBe(false)
    expect(existsSync(join(project, 'pwned'))).toBe(false)
  })

  it('lists one level of visible, real folders and returns the canonical path first', async () => {
    const project = await realpath(await mkdtemp(join(home, 'project-')))
    for (const name of ['api', 'web', '.git', 'with space']) await mkdir(join(project, name))
    await writeFile(join(project, 'file.txt'), 'x')
    await symlink(home, join(project, 'link-to-home'))
    await mkdir(join(project, 'api', 'nested'))
    const result = remote(listDirectoriesScript(project))
    expect(result.status).toBe(0)
    const [path, ...names] = result.stdout.toString().trim().split('\n')
    expect(path).toBe(project)
    expect(names.sort()).toEqual(['api', 'web', 'with space'])
    const unreadable = remote(listDirectoriesScript(join(project, 'missing')))
    expect(unreadable.status).not.toBe(0)
  })

  it('only resolves folders the agent can write to, following links to their real path', async () => {
    const project = await realpath(await mkdtemp(join(home, 'project-')))
    await symlink(project, join(home, 'shortcut'))
    const followed = remote(resolveDirectoryScript(join(home, 'shortcut')))
    // System name, canonical home, canonical folder.
    expect(followed.stdout.toString().trim().split('\n')).toEqual([process.platform === 'darwin' ? 'Darwin' : 'Linux', await realpath(home), project])
    if (process.getuid?.() !== 0) {
      const locked = join(project, 'locked')
      await mkdir(locked, { mode: 0o500 })
      expect(remote(resolveDirectoryScript(locked)).status).not.toBe(0)
    }
  })
})
