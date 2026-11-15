/**
 * How long a message for an agent the service runs through agl on this
 * computer is left to the service before this desktop takes it itself. The
 * service may not take it (it thinks the machine is offline, it is down):
 * then the desktop runs it as before, so nothing waits forever. Claims are
 * revision-checked on both sides, so it still runs exactly once.
 */
export const AGL_GRACE_MS = 30_000

/** `createdAt` as epoch ms (a number or an ISO string); undefined when it is neither. */
function epoch(value: unknown): number | undefined {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * How much of the grace window is left for a message created at `createdAt`
 * (another device's or the service's clock). Its age is clamped to
 * [0, grace], so a clock ahead of this one never stretches the wait past the
 * window and one behind it at worst ends the wait now. Without a usable
 * `createdAt`, the whole window is left (counted from first sight).
 */
export function aglGraceRemaining(createdAt: unknown, now: number, grace = AGL_GRACE_MS): number {
  const created = epoch(createdAt)
  if (created === undefined) return grace
  return grace - Math.min(grace, Math.max(0, now - created))
}

/**
 * Deadlines of messages being left to the service, fixed when first seen,
 * so the window is never restarted by seeing the message again.
 */
export class AglGraceWindows {
  private readonly deadlines = new Map<string, number>()
  constructor(private readonly now: () => number = Date.now, private readonly grace = AGL_GRACE_MS) {}

  /** Whether `id` is still within its window (and the service should get it); starts the window on first sight. */
  waiting(id: string, createdAt: unknown): boolean {
    const now = this.now()
    let deadline = this.deadlines.get(id)
    if (deadline === undefined) { deadline = now + aglGraceRemaining(createdAt, now, this.grace); this.deadlines.set(id, deadline) }
    return now < deadline
  }

  /** Milliseconds left for `id` (0 when its window ended or it is unknown). */
  remaining(id: string): number { return Math.max(0, (this.deadlines.get(id) ?? 0) - this.now()) }

  forget(id: string): void { this.deadlines.delete(id) }
  /** Forgets every id not in `ids` (the ones no longer pending). */
  retain(ids: Iterable<string>): void {
    const keep = new Set(ids)
    for (const id of this.deadlines.keys()) if (!keep.has(id)) this.deadlines.delete(id)
  }
  clear(): void { this.deadlines.clear() }
}
