import type { AppSnapshot, SnapshotPatch } from '../shared/types'

interface SnapshotTarget {
  isDestroyed(): boolean
  send(channel: string, payload: SnapshotPatch): void
}

/**
 * Sends each window only the top-level parts of the snapshot that changed
 * since the last one it was sent. The runtime reuses stored parts (messages,
 * conversations, agents) until something is written, so while an agent works
 * a push is a few small fields instead of every recent message in every chat.
 *
 * A window's first push is whole. `reset` records the snapshot a window just
 * asked for directly, so later pushes build on what it really has.
 */
export class SnapshotPublisher<Target extends SnapshotTarget> {
  private sent = new WeakMap<Target, AppSnapshot>()

  constructor(private channel: string) {}

  publish(targets: Target[], snapshot: AppSnapshot): void {
    for (const target of targets) {
      try {
        if (target.isDestroyed()) continue
        const previous = this.sent.get(target)
        this.sent.set(target, snapshot)
        if (!previous) {
          target.send(this.channel, { full: true, values: snapshot })
          continue
        }
        const values = snapshotChanges(previous, snapshot)
        if (Object.keys(values).length) target.send(this.channel, { full: false, values })
      } catch (error) {
        // Native objects can be destroyed between the check and send().
        this.sent.delete(target)
        console.warn(`[douchat] Could not notify renderer (${this.channel}):`, error instanceof Error ? error.message : error)
      }
    }
  }

  reset(target: Target, snapshot: AppSnapshot): void {
    this.sent.set(target, snapshot)
  }
}

/** Top-level fields of `next` whose value is not the very same as in `previous`. */
export function snapshotChanges(previous: AppSnapshot, next: AppSnapshot): Partial<AppSnapshot> {
  const changes: Record<string, unknown> = {}
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
  for (const key of keys) {
    const before = (previous as unknown as Record<string, unknown>)[key]
    const after = (next as unknown as Record<string, unknown>)[key]
    // A removed optional field is sent as undefined so the window drops it.
    if (before !== after) changes[key] = after
  }
  return changes as Partial<AppSnapshot>
}
