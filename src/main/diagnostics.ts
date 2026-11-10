import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

let timingLog: DiagnosticLog | undefined
export function configureTimingLog(log: DiagnosticLog): void { timingLog = log }

/** How long one stage of remote execution took. Only ids and outcomes: never prompts, output or errors. */
export function recordTiming(stage: string, startedAt: number, context: Record<string, unknown> = {}): void {
  timingLog?.write('remote.timing', JSON.stringify({ stage, durationMs: Date.now() - startedAt, ...context }))
}

export async function timedRemote<T>(stage: string, context: Record<string, unknown>, operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now()
  try {
    const result = await operation()
    recordTiming(stage, startedAt, { ...context, outcome: 'ok' })
    return result
  } catch (error) {
    recordTiming(stage, startedAt, { ...context, outcome: 'error' })
    throw error
  }
}

/** Best-effort diagnostics: never throw into the UI, retain at most two files. */
export class DiagnosticLog {
  readonly file: string
  constructor(readonly directory: string, private readonly maxBytes = 2 * 1024 * 1024) {
    this.file = join(directory, 'diagnostics.log')
  }
  write(event: string, detail = ''): void {
    try {
      mkdirSync(this.directory, { recursive: true })
      const line = JSON.stringify({ time: new Date().toISOString(), event: redact(event).slice(0, 120), detail: redact(detail).slice(0, 12000) }) + '\n'
      let size = 0
      try { size = statSync(this.file).size } catch { /* first write */ }
      if (size && size + Buffer.byteLength(line) > this.maxBytes) renameSync(this.file, `${this.file}.1`)
      appendFileSync(this.file, line, { encoding: 'utf8', mode: 0o600 })
    } catch { /* Disk full / permissions must not break the application. */ }
  }
}

export function redact(text: string): string {
  return text
    .replace(/([a-z][a-z\d+.-]*:\/\/[^\s?#]+)[?#][^\s)]+/gi, '$1?[redacted]')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]')
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[redacted]')
}
