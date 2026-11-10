import type { AgentConfig, AgentWorkspaceBinding, Conversation, ExecutionTarget } from './types'

type Member = Pick<AgentConfig, 'id' | 'ownerId'>
type Target = Pick<Conversation, 'type' | 'agentIds' | 'ownerId' | 'remoteRoomId' | 'person' | 'socialRoom'>
type WorkspaceChat = Target & Pick<Conversation, 'workspacePath' | 'agentWorkspaces' | 'hostWorkspaces'>
/** Folders on a server a douchat-host runs agents on (target `daemon:<hostId>`). */
export const isHostTarget = (target: ExecutionTarget): boolean => target.executionTargetId.startsWith('daemon:')

/** The chat-wide folder (legacy) is available only to the owner's agents in private, unshared chats. */
export function canAssignConversationWorkspace(conversation: Target | undefined, agents: readonly Member[], accountId = conversation?.ownerId): boolean {
  if (!conversation || !accountId || conversation.ownerId !== accountId) return false
  if (conversation.remoteRoomId || conversation.person || conversation.socialRoom) return false
  if (!conversation.agentIds.length || (conversation.type === 'direct' && conversation.agentIds.length !== 1)) return false
  return conversation.agentIds.every((id) => {
    const agent = agents.find((item) => item.id === id)
    return agent?.ownerId === accountId
  })
}

/** Local ids of the owner's agents in a chat. Shared rooms list server ids, so
 * the owner's members are taken from the room's agent records instead. */
export function ownMemberAgentIds(conversation: Target, accountId = conversation.ownerId): string[] {
  if (!accountId || conversation.ownerId !== accountId || conversation.person) return []
  if (conversation.socialRoom) return conversation.socialRoom.agents.filter(agent => agent.ownerId === accountId).map(agent => agent.localId)
  if (conversation.remoteRoomId) return []
  return conversation.agentIds
}

/** A member folder is set per agent, by that agent's owner only, in their own
 * chats and shared rooms. Chats with friends have no agent to configure. */
export function canAssignAgentWorkspace(conversation: Target | undefined, agent: Member | undefined, accountId = conversation?.ownerId): boolean {
  if (!conversation || !agent || !accountId || agent.ownerId !== accountId) return false
  return ownMemberAgentIds(conversation, accountId).includes(agent.id)
}

export function sameExecutionTarget(a: ExecutionTarget, b: ExecutionTarget): boolean {
  return a.executionTargetId === b.executionTargetId && a.targetRevision === b.targetRevision
}

export interface MemberWorkspace {
  eligible: boolean
  /** A folder chosen for this agent on its current computer or server. */
  binding?: AgentWorkspaceBinding
  /** A folder chosen on another target, or before the target was edited. Never used. */
  stale?: AgentWorkspaceBinding
  /** The chat's earlier local folder, which only applies to members on this computer. */
  legacyPath?: string
}

/** The one resolution of a member's folder, shared by the UI and the runtime. */
export function memberWorkspace(conversation: WorkspaceChat | undefined, agent: Member | undefined, target: ExecutionTarget & { location: 'local' | 'remote' }, agents: readonly Member[], accountId = conversation?.ownerId): MemberWorkspace {
  if (!conversation || !agent || !canAssignAgentWorkspace(conversation, agent, accountId)) return { eligible: false }
  const saved = isHostTarget(target) ? conversation.hostWorkspaces?.[agent.id] : conversation.agentWorkspaces?.[agent.id]
  if (saved && sameExecutionTarget(saved, target)) return { eligible: true, binding: saved }
  const legacyPath = target.location === 'local' && conversation.workspacePath && canAssignConversationWorkspace(conversation, agents, accountId)
    ? conversation.workspacePath : undefined
  return { eligible: true, ...(saved ? { stale: saved } : {}), ...(legacyPath ? { legacyPath } : {}) }
}
