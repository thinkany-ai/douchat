import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import { editableIdentityFiles } from '../shared/agentFileEdits'
import { validateAgentFiles, type AgentFiles } from '../shared/agentCustomization'
import type { AgentConfig } from '../shared/types'

export function profileDirectory(root: string, owner: string, agent?: string): string {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  return join(root, hash(owner), ...(agent ? ['agents', hash(agent)] : ['shared']))
}
export function atomicProfileWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try { writeFileSync(temporary, content, { mode: 0o600 }); renameSync(temporary, path) }
  finally { rmSync(temporary, { force: true }) }
}

/** Files are authoritative; database fields are only migration/recovery snapshots. */
export class AgentProfileFiles {
  constructor(private root: string) {}
  private changes = 0
  private watcher?: FSWatcher | null

  /**
   * Changes whenever a profile file may have changed, so callers can reuse
   * what they built from `load()` until then. Edits made outside Douchat (an
   * agent rewriting its own SOUL.md, say) are seen through a file watcher;
   * where watching is unavailable the version simply moves every second.
   * Either way it also moves every ten seconds in case an event was missed.
   */
  version(now = Date.now()): string {
    if (this.watcher === undefined) this.startWatching()
    return `${this.changes}:${Math.floor(now / (this.watcher ? 10_000 : 1_000))}`
  }

  private startWatching(): void {
    this.watcher = null
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 })
      const watcher = watch(this.root, { recursive: true }, () => { this.changes += 1 })
      watcher.on('error', () => { watcher.close(); this.watcher = null; this.changes += 1 })
      watcher.unref()
      this.watcher = watcher
    } catch {
      this.watcher = null
    }
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
  }

  directory(agent: AgentConfig): string { return profileDirectory(this.root, agent.ownerId!, agent.id) }
  private recover(directory: string): void {
    const journal = join(directory, '.pending-files.json')
    if (!existsSync(journal)) return
    const changes = validateAgentFiles(JSON.parse(readFileSync(journal, 'utf8')))
    for (const [name, content] of Object.entries(changes)) {
      if (!editableIdentityFiles.includes(name as typeof editableIdentityFiles[number])) throw new Error('Invalid profile file transaction')
      atomicProfileWrite(join(directory, name), content)
    }
    rmSync(journal)
  }
  load(agent: AgentConfig): AgentConfig {
    if (!agent.ownerId) return agent
    const directory = this.directory(agent)
    this.recover(directory)
    const initialized = join(directory, '.initialized')
    if (!existsSync(initialized)) {
      for (const name of editableIdentityFiles) {
        const path = join(directory, name)
        if (!existsSync(path) && agent.systemFiles?.[name] !== undefined) atomicProfileWrite(path, agent.systemFiles[name]!)
      }
      atomicProfileWrite(initialized, '1\n')
    }
    const files: AgentFiles = { ...agent.systemFiles }
    for (const name of editableIdentityFiles) {
      const path = join(directory, name)
      try {
        const content = readFileSync(path, 'utf8')
        validateAgentFiles({ [name]: content })
        files[name] = content
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // A removed file must not resurrect the database's old instructions.
        if (files[name] !== undefined) files[name] = ''
      }
    }
    return { ...agent, ...(Object.keys(files).length ? { systemFiles: files } : {}), systemFilesDirectory: directory }
  }
  save(agent: AgentConfig, changes: AgentFiles): void {
    if (!agent.ownerId) return
    const values = Object.fromEntries(Object.entries(validateAgentFiles(changes)).filter(([name]) => editableIdentityFiles.includes(name as typeof editableIdentityFiles[number])))
    if (!Object.keys(values).length) return
    const directory = this.directory(agent)
    this.changes += 1
    this.recover(directory)
    // A durable journal finishes a batch after an interrupted process/write.
    atomicProfileWrite(join(directory, '.pending-files.json'), JSON.stringify(values))
    this.recover(directory)
  }
  remove(agent: AgentConfig): void {
    this.changes += 1
    if (agent.ownerId) rmSync(this.directory(agent), { recursive: true, force: true })
  }
}
