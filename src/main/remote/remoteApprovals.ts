import type { PermissionApproval, PermissionRequest } from '../../shared/agentPermissions'

/** A waiting approval written by a douchat-host (remote-connections.md 6.4.3). */
export interface RemoteApprovalContent {
  id: string
  hostId: string
  taskId: string
  bindingRevision: number
  claimHash: string
  requestId: string
  capability: string
  /** What "Allow for this task" covers (a tool), when the host offers it. */
  taskScope?: string
  operation: string
  details: string
  requester: string
  paramsHash: string
  createdAt: number
  expiresAt: number
}

/** Where a remote approval came from, resolved on this computer. */
export interface RemoteApprovalContext {
  ownerId: string
  /** Local AgentConfig id (the social localId). */
  agentId: string
  agentName: string
  roomName: string
  context: 'direct' | 'group'
  /** The daemon connection's local name. */
  executorLabel: string
}

export const REMOTE_APPROVAL_PREFIX = 'remote:'
/** Per host, matching the server's limit; never shares the local broker's queue. */
export const MAX_REMOTE_APPROVALS_PER_HOST = 20

/** The signed decision for one host approval. */
export function approvalDecision(allow: PermissionApproval): { decision: 'allow' | 'deny'; scope: 'once' | 'task' | 'session' } {
  if (allow === 'task') return { decision: 'allow', scope: 'task' }
  if (allow === 'session') return { decision: 'allow', scope: 'session' }
  return allow === true ? { decision: 'allow', scope: 'once' } : { decision: 'deny', scope: 'once' }
}

function validApproval(value: unknown): RemoteApprovalContent | undefined {
  const item = value as RemoteApprovalContent
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id.includes(':approval:') || item.id.length > 400) return undefined
  if (typeof item.hostId !== 'string' || typeof item.taskId !== 'string' || typeof item.claimHash !== 'string' || typeof item.requestId !== 'string' || typeof item.paramsHash !== 'string') return undefined
  if (!Number.isSafeInteger(item.bindingRevision) || !Number.isFinite(item.createdAt) || !Number.isFinite(item.expiresAt)) return undefined
  const text = (field: unknown, max: number) => String(field ?? '').slice(0, max)
  return { ...item, capability: text(item.capability, 100), operation: text(item.operation, 200), details: text(item.details, 4000), requester: text(item.requester, 200),
    ...(typeof item.taskScope === 'string' && item.taskScope ? { taskScope: text(item.taskScope, 200) } : {}) }
}

/**
 * Remote approvals waiting for this owner. The task-progress-watch snapshot is
 * authoritative: anything missing from it was answered, expired or ended and
 * its card disappears. Nothing here enters the local AgentPermissionBroker.
 */
export class RemoteApprovals {
  private items = new Map<string, { content: RemoteApprovalContent; request: PermissionRequest }>()

  /** Replace everything with the latest snapshot. Returns whether the visible list changed. */
  sync(approvals: { content: unknown; context: RemoteApprovalContext }[], now = Date.now()): boolean {
    const next = new Map<string, { content: RemoteApprovalContent; request: PermissionRequest }>()
    const perHost = new Map<string, number>()
    for (const { content: raw, context } of approvals) {
      const content = validApproval(raw)
      if (!content || content.expiresAt <= now) continue
      const count = perHost.get(content.hostId) ?? 0
      if (count >= MAX_REMOTE_APPROVALS_PER_HOST) continue
      perHost.set(content.hostId, count + 1)
      const id = `${REMOTE_APPROVAL_PREFIX}${content.id}`
      next.set(id, { content, request: {
        id, ownerId: context.ownerId, agentId: context.agentId, agentName: context.agentName,
        requester: content.requester || context.agentName, roomName: context.roomName, context: context.context,
        capability: (content.capability || 'otherTools') as PermissionRequest['capability'],
        operation: content.operation, details: content.details, createdAt: content.createdAt,
        executorLabel: context.executorLabel, expiresAt: content.expiresAt, ...(content.taskScope ? { taskScope: content.taskScope } : {})
      } })
    }
    const before = JSON.stringify([...this.items.keys()])
    this.items = next
    return before !== JSON.stringify([...next.keys()])
  }

  snapshot(now = Date.now()): PermissionRequest[] {
    return [...this.items.values()].filter(item => item.content.expiresAt > now).sort((a, b) => a.content.createdAt - b.content.createdAt).map(item => item.request)
  }

  get(id: string): RemoteApprovalContent | undefined { return this.items.get(id)?.content }

  /** Hide a card once its answer was accepted; the next snapshot confirms it. */
  remove(id: string): void { this.items.delete(id) }

  clear(): void { this.items.clear() }
}
