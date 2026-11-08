import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'

const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} })
/** Resolve every existing component. Reject symlinks rather than following them out of the selected folder.
 * Asynchronous like the rest of these tools: they run on the main process,
 * and a slow or network disk must not freeze the window while an agent works. */
async function target(root: string, path: string, writing = false): Promise<string> {
  if (isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').some(p => p === '..')) throw new Error('Use a relative path inside the workspace')
  const base = await realpath(root)
  let current = base
  const parts = path.split('/').filter(p => p && p !== '.')
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i])
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink()) throw new Error('Workspace symbolic links are not supported')
      if (i < parts.length - 1 && !stat.isDirectory()) throw new Error('Not a directory')
    } catch (error) {
      if (!writing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (i < parts.length - 1) await mkdir(current)
    }
  }
  if (relative(base, current).startsWith('..')) throw new Error('Outside workspace')
  return current
}
export function createWorkspaceTools(directory: () => string, lock: (directory: string, signal: AbortSignal) => Promise<() => void>): AgentTool[] {
  const read = Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })) })
  const write = Type.Object({ path: Type.String(), content: Type.String(), overwrite: Type.Optional(Type.Boolean({ description: 'Set true only when intentionally replacing an existing file.' })) })
  return [
    { name: 'list_workspace_files', label: 'List workspace', description: 'List files in this conversation’s workspace. Use relative paths; omit path for the root. Does not follow symbolic links.', parameters: Type.Object({ path: Type.Optional(Type.String()) }), execute: async (_id, args: { path?: string }, signal) => {
      signal?.throwIfAborted(); const root = directory()
      const entries = await readdir(await target(root, args.path ?? ''), { withFileTypes: true })
      return reply({ directory: root, entries: entries.slice(0, 500).map(e => ({ name: e.name, type: e.isSymbolicLink() ? 'link' : e.isDirectory() ? 'directory' : 'file' })), truncated: entries.length > 500 })
    } },
    { name: 'read_workspace_file', label: 'Read workspace file', description: 'Read a UTF-8 workspace file, up to 20 MB, paginated in 20000-character chunks. Binary files need a format-specific tool.', parameters: read, execute: async (_id, args: { path: string; offset?: number }, signal) => {
      signal?.throwIfAborted()
      const file = await open(await target(directory(), args.path), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('Expected a file no larger than 20 MB')
        const bytes = Buffer.alloc(stat.size); let count = 0
        while (count < bytes.length) { const { bytesRead } = await file.read(bytes, count, bytes.length - count, null); if (!bytesRead) break; count += bytesRead }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))
        if (text.includes('\0')) throw new Error('Binary file requires a format-specific tool')
        const offset = args.offset ?? 0
        return reply({ content: text.slice(offset, offset + 20000), nextOffset: offset + 20000 < text.length ? offset + 20000 : null, totalCharacters: text.length })
      } finally { await file.close() }
    } },
    { name: 'write_workspace_file', label: 'Write workspace file', description: 'Write complete UTF-8 content in the conversation workspace (maximum 4 MB). Parent folders are created. Existing files require overwrite=true. Read existing files before editing.', parameters: write, execute: async (_id, args: { path: string; content: string; overwrite?: boolean }, signal) => {
      const root = directory(), release = await lock(root, signal ?? new AbortController().signal)
      try {
        signal?.throwIfAborted(); if (directory() !== root) throw new Error('Workspace changed; retry')
        if (Buffer.byteLength(args.content) > 4 * 1024 * 1024) throw new Error('Content exceeds 4 MB')
        const path = await target(root, args.path, true)
        const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (args.overwrite ? 0 : constants.O_EXCL), 0o600)
        try {
          const stat = await file.stat()
          if (!stat.isFile() || stat.nlink > 1) throw new Error('Not a regular file')
          // Writing through a handle does not truncate existing trailing bytes.
          signal?.throwIfAborted(); await file.truncate(0); await file.writeFile(args.content)
        } finally { await file.close() }
        return reply({ path, bytes: Buffer.byteLength(args.content), saved: true })
      } finally { release() }
    } }
  ] as AgentTool[]
}
