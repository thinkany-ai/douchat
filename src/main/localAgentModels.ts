import { appendLocalAgentArguments } from '../shared/localAgentArguments'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configurableLocalAgents, type LocalModel, type LocalModelList } from '../shared/localModels'
import { validateLocalAgent } from './localAgents'
import { spawnEnvironment } from './shellPath'
import { executableCommand } from './windowsCommand'
import { LocalAgentConnection, killLocalProcess, spawnOwnedProcess } from './localAgentConnection'
import { acquireLocalProcessSlot, localAgentExecutable } from './localAgentRuntime'
import type { LocalAgent, RemoteAgentSpec } from '../shared/types'
import { RemoteRun } from './remoteFileChannel'
import { openSshTransport } from './remote/sshTransport'

export function parseLocalModels(id: string, output: string): LocalModel[] {
  const clean = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  if (id === 'openclaw') {
    const data = JSON.parse(clean)
    return (data.models ?? []).filter((m: any) => typeof m.key === 'string').map((m: any) => ({ id: m.key, name: m.name || m.key }))
  }
  if (id === 'omp') {
    const data = JSON.parse(clean)
    return (data.models ?? [])
      .filter((m: any) => typeof m.provider === 'string' && m.provider && typeof m.id === 'string' && m.id)
      .map((m: any) => ({ id: `${m.provider}/${m.id}`, name: m.name || m.id }))
  }
  const models: LocalModel[] = []
  for (const line of clean.split(/\r?\n/)) {
    if (id === 'opencode' && /^[\w.-]+\/\S+$/.test(line.trim())) models.push({ id: line.trim(), name: line.trim() })
    if (id === 'cursor') {
      const match = line.trim().match(/^(\S+) - (.+)$/)
      if (match) models.push({ id: match[1], name: match[2] })
    }
    if (id === 'grok') {
      const match = line.match(/^\s+[*-]\s+(\S+)/)
      if (match) models.push({ id: match[1], name: match[1] })
    }
  }
  return [...new Map(models.map(model => [model.id, model])).values()]
}

const modelRequests = new Map<string, Promise<LocalModelList>>()
const modelCancellations = new Map<string, AbortController>()
export function cancelLocalModelQueries(): void {
  for (const abort of modelCancellations.values()) abort.abort(new Error('Model discovery stopped'))
  modelCancellations.clear()
  modelRequests.clear()
}
/** agl's model list for an agent, or undefined to discover it the desktop's way. */
export type AglModels = (agentId: string) => Promise<LocalModel[] | undefined>
let aglModels: AglModels | undefined
/** Experimental "Use agl for local agents": model lists of agents agl supports come from `agents.models`. */
export function configureAglModels(source: AglModels | undefined): void { aglModels = source }

export function listLocalAgentModels(id: string): Promise<LocalModelList> {
  const existing = modelRequests.get(id)
  if (existing) return existing
  const abort = new AbortController()
  modelCancellations.set(id, abort)
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])
  const work = (async () => {
    const release = await acquireLocalProcessSlot(signal)
    try { return await discoverLocalAgentModels(id, signal) } finally { release() }
  })().finally(() => {
    if (modelRequests.get(id) === work) modelRequests.delete(id)
    if (modelCancellations.get(id) === abort) modelCancellations.delete(id)
  })
  modelRequests.set(id, work)
  return work
}

async function discoverLocalAgentModels(id: string, signal: AbortSignal): Promise<LocalModelList> {
  const agent = await validateLocalAgent(id, { allowAgl: true })
  // agl picks the agent's default model on the device; choosing one is not offered in v1.
  if (agent.agl) return { models: [], source: 'manual', configurable: false }
  if (agent.remote) return discoverRemoteModels(agent, agent.remote, signal)
  if (!configurableLocalAgents.includes(id)) return { models: [], source: 'manual', configurable: false }
  // Catalog agents only: custom commands and arguments are the desktop's to probe.
  if (aglModels && !agent.custom && !agent.args?.length) {
    const models = await aglModels(id).catch(() => undefined)
    signal.throwIfAborted()
    if (models?.length) return { models, source: 'agent', configurable: true }
  }
  // These CLIs accept a model override but don't expose a stable non-interactive catalog.
  if (!['codex', 'claude', 'opencode', 'cursor', 'grok', 'openclaw', 'omp'].includes(id)) return { models: [], source: 'manual', configurable: true }
  const env = await spawnEnvironment()
  const cwd = await mkdtemp(join(tmpdir(), 'douchat-models-'))
  try {
    const executable = id === 'grok' && agent.command !== 'grok' ? agent.path! : await localAgentExecutable(id, agent.path!)
    signal.throwIfAborted()
    if (id === 'codex' || id === 'claude') {
      const connection = new LocalAgentConnection(id)
      const cancel = () => connection.close(new Error('Model discovery stopped'))
      signal.addEventListener('abort', cancel, { once: true })
      const timer = setTimeout(() => connection.close(new Error('Model discovery timed out')), 15000)
      try {
        await connection.connect(executable, cwd, env, undefined, true, undefined, false, agent.args)
        return { models: await connection.models(), source: 'agent', configurable: true }
      } finally { signal.removeEventListener('abort', cancel); clearTimeout(timer); connection.close(); await connection.disposed() }
    }
    const command = await executableCommand(executable)
    const args = id === 'openclaw' ? ['models', 'list', '--json'] : id === 'omp' ? ['models', '--json'] : ['models']
    signal.throwIfAborted()
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawnOwnedProcess(command.file, [...command.prefix, ...appendLocalAgentArguments(args, agent.args)], { cwd, env, windowsHide: true })
      let stdout = ''
      let failure: Error | undefined
      const stop = (error: Error): void => { failure = error; killLocalProcess(child) }
      const cancel = () => stop(new Error('Model discovery stopped'))
      signal.addEventListener('abort', cancel, { once: true })
      const timer = setTimeout(() => stop(new Error('Model discovery timed out')), 15000)
      child.stdout.on('data', chunk => {
        stdout += chunk.toString()
        if (stdout.length > 2_000_000) stop(new Error('Model list is too large'))
      })
      child.stderr.resume()
      child.on('error', error => { failure = error; killLocalProcess(child) })
      child.on('close', code => { signal.removeEventListener('abort', cancel); clearTimeout(timer); killLocalProcess(child); failure ? reject(failure) : code === 0 ? resolve(stdout) : reject(new Error('Could not load models. Check the local agent login and configuration.')) })
      child.stdin.on('error', () => {})
      child.stdin.end()
    })
    return { models: parseLocalModels(id, output), source: 'agent', configurable: true }
  } finally { await rm(cwd, { recursive: true, force: true }) }
}

/** Same catalog commands, launched on the server through the fixed ssh path. */
async function discoverRemoteModels(agent: LocalAgent, input: RemoteAgentSpec, signal: AbortSignal): Promise<LocalModelList> {
  const adapter = input.adapter
  if (!configurableLocalAgents.includes(adapter)) return { models: [], source: 'manual', configurable: false }
  if (!['codex', 'claude', 'opencode', 'cursor', 'grok', 'openclaw', 'omp'].includes(adapter)) return { models: [], source: 'manual', configurable: true }
  const transport = await openSshTransport(input, signal)
  const spec = transport.spec
  const run = new RemoteRun(transport)
  try {
    await run.prepare(signal)
    const launch = (args: string[]) => transport.spawn({ runId: run.id, executable: spec.executable, args, channel: 'stdin' })
    if (adapter === 'codex' || adapter === 'claude') {
      const connection = new LocalAgentConnection(adapter)
      const cancel = () => connection.close(new Error('Model discovery stopped'))
      signal.addEventListener('abort', cancel, { once: true })
      const timer = setTimeout(() => connection.close(new Error('Model discovery timed out')), 15000)
      try {
        await connection.connect(spec.executable, run.workspace, {}, undefined, true, undefined, false, spec.args, undefined, { cwd: run.workspace, spawn: launch })
        return { models: await connection.models(), source: 'agent', configurable: true }
      } finally { signal.removeEventListener('abort', cancel); clearTimeout(timer); connection.close(); await connection.disposed() }
    }
    const args = adapter === 'openclaw' ? ['models', 'list', '--json'] : adapter === 'omp' ? ['models', '--json'] : ['models']
    const child = await launch(appendLocalAgentArguments(args, spec.args))
    const output = await new Promise<string>((resolve, reject) => {
      let stdout = ''
      let failure: Error | undefined
      const stop = (error: Error): void => { failure = error; killLocalProcess(child) }
      const cancel = () => stop(new Error('Model discovery stopped'))
      signal.addEventListener('abort', cancel, { once: true })
      const timer = setTimeout(() => stop(new Error('Model discovery timed out')), 15000)
      child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 2_000_000) stop(new Error('Model list is too large')) })
      child.stderr.resume()
      child.on('error', error => stop(error))
      child.on('close', code => { signal.removeEventListener('abort', cancel); clearTimeout(timer); killLocalProcess(child); failure ? reject(failure) : code === 0 ? resolve(stdout) : reject(new Error(`Could not load models from ${agent.name}. Check its login on the server.`)) })
      child.stdin.on('error', () => {})
      child.stdin.end()
    })
    return { models: parseLocalModels(adapter, output), source: 'agent', configurable: true }
  } finally { await run.dispose(true) }
}
