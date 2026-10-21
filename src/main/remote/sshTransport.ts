import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { RemoteAgentSpec, RemoteDirectoryListing } from '../../shared/types'
import { closeRemoteConnections, probeRemoteAgent, remoteCheck, remoteExec, remoteLaunch, spawnLaunch, type RemoteExecOptions, type RemoteExecResult } from '../remoteTransport'
import {
  beginTurnScript, cleanupScript, framesScript, killScript, launchScript, prepareScript, runFileScript, uploadScript,
  type FramesScriptOptions, type LaunchScriptOptions, type RemoteWorkspaceRef
} from '../remoteScript'
import { listRemoteDirectories, resolveRemoteWorkspace } from '../remoteWorkspace'
import { openDaemonSkillBridge, openRemoteSkillBridge, type SkillBridge } from '../remoteSkillBridge'
import { relaySpawn } from './daemonRelay'
import { timedRemote } from '../diagnostics'

export type ProbedSpec = RemoteAgentSpec & { remotePath: string; remoteHome: string }

/** Everything Douchat does on a server, by meaning rather than by script.
 * The POSIX templates stay in remoteScript.ts; every dynamic value is
 * validated there and only travels in the base64 payload. The same scripts
 * run over /usr/bin/ssh or, for a douchat-host connection, through the
 * Douchat relay (remote/daemonRelay.ts); nothing else differs. */
export interface RemoteTransport {
  readonly kind: 'ssh' | 'daemon'
  /** Validated settings plus the login PATH and HOME found on the server. */
  readonly spec: ProbedSpec
  readonly home: string
  exec(script: string, options?: RemoteExecOptions): Promise<RemoteExecResult>
  check(script: string, options?: RemoteExecOptions): Promise<Buffer>
  prepareRun(runId: string, workspace: RemoteWorkspaceRef, signal?: AbortSignal): Promise<void>
  upload(runId: string, name: string, data: Uint8Array, signal?: AbortSignal): Promise<void>
  beginTurn(runId: string, signal?: AbortSignal): Promise<void>
  frames(options: FramesScriptOptions, signal: AbortSignal | undefined, maxStdout: number): Promise<RemoteExecResult>
  runFile(runId: string, name: 'reply.txt', maxBytes: number, maxStdout: number, signal?: AbortSignal): Promise<RemoteExecResult>
  /** Start the agent; the prompt, if any, goes to the process's stdin, never into the script. */
  spawn(options: LaunchScriptOptions): Promise<ChildProcessWithoutNullStreams>
  interrupt(runId: string): Promise<void>
  cleanupRun(runId: string, kill: boolean): Promise<void>
  listDirectories(parent?: string, name?: string, signal?: AbortSignal): Promise<RemoteDirectoryListing>
  resolveDirectory(parent: unknown, name?: unknown, signal?: AbortSignal): Promise<string>
  openBridge(tools: AgentTool[], signal: AbortSignal): Promise<SkillBridge | undefined>
  close(): Promise<void>
}

class SshTransport implements RemoteTransport {
  constructor(readonly spec: ProbedSpec) {}
  get kind(): 'ssh' | 'daemon' { return this.spec.transport }
  get home(): string { return this.spec.remoteHome }
  exec(script: string, options?: RemoteExecOptions): Promise<RemoteExecResult> { return remoteExec(this.spec, script, options) }
  check(script: string, options?: RemoteExecOptions): Promise<Buffer> { return remoteCheck(this.spec, script, options) }
  async prepareRun(runId: string, workspace: RemoteWorkspaceRef, signal?: AbortSignal): Promise<void> {
    await timedRemote('prepare', { runId, transport: this.kind }, () => this.check(prepareScript(runId, workspace), { signal, timeoutMs: 30_000 }))
  }
  async upload(runId: string, name: string, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    const output = await this.check(uploadScript(runId, name, data.byteLength), { input: data, signal, timeoutMs: 120_000, maxStdout: 64 })
    if (output.toString('utf8').trim() !== String(data.byteLength)) throw new Error('Remote upload was incomplete')
  }
  async beginTurn(runId: string, signal?: AbortSignal): Promise<void> {
    await timedRemote('turn.prepare', { runId, transport: this.kind }, () => this.check(beginTurnScript(runId), { signal, timeoutMs: 15_000 }))
  }
  frames(options: FramesScriptOptions, signal: AbortSignal | undefined, maxStdout: number): Promise<RemoteExecResult> {
    return timedRemote('files.scan', { transport: this.kind }, () => this.exec(framesScript(options), { signal, timeoutMs: options.listOnly ? 30_000 : 120_000, maxStdout }))
  }
  runFile(runId: string, name: 'reply.txt', maxBytes: number, maxStdout: number, signal?: AbortSignal): Promise<RemoteExecResult> {
    return this.exec(runFileScript(runId, name, maxBytes), { signal, timeoutMs: 60_000, maxStdout })
  }
  async spawn(options: LaunchScriptOptions): Promise<ChildProcessWithoutNullStreams> {
    const script = launchScript({ ...options, remotePath: this.spec.remotePath })
    if (this.spec.transport === 'daemon') return relaySpawn(this.spec, script)
    return spawnLaunch(await remoteLaunch(this.spec, script))
  }
  async interrupt(runId: string): Promise<void> { await this.exec(killScript(runId), { timeoutMs: 10_000 }).catch(() => undefined) }
  async cleanupRun(runId: string, kill: boolean): Promise<void> { await this.exec(cleanupScript(runId, kill), { timeoutMs: 15_000 }).catch(() => undefined) }
  listDirectories(parent?: string, name?: string, signal?: AbortSignal): Promise<RemoteDirectoryListing> { return listRemoteDirectories(this.spec, parent, name, signal) }
  resolveDirectory(parent: unknown, name?: unknown, signal?: AbortSignal): Promise<string> { return resolveRemoteWorkspace(this.spec, parent, name, signal) }
  openBridge(tools: AgentTool[], signal: AbortSignal): Promise<SkillBridge | undefined> {
    return this.spec.transport === 'daemon' ? openDaemonSkillBridge(this.spec, tools, signal) : openRemoteSkillBridge(this.spec, tools, signal)
  }
  async close(): Promise<void> { if (this.spec.transport === 'ssh') await closeRemoteConnections(this.spec) }
}

/** Probe the server (cached for 10 minutes) and return a transport for it,
 * over ssh or douchat-host as the spec says. */
export async function openSshTransport(spec: RemoteAgentSpec, signal?: AbortSignal, fresh = false): Promise<RemoteTransport> {
  return new SshTransport(await timedRemote('probe', { transport: spec.transport }, () => probeRemoteAgent(spec, signal, fresh)))
}
/** A transport over settings that were already probed. */
export function sshTransport(spec: ProbedSpec): RemoteTransport { return new SshTransport(spec) }
