/** Whether a turn's session key belongs to a conversation (and, if given, one of its topics).
 * Shared by every executor so a reset reaches each of them the same way. */
export function conversationMatcher(conversationId: string, topicId?: string, directAgentIds: string[] = []): (sessionKey: string) => boolean {
  const prefixes = [`direct:${conversationId}:`, `group:${encodeURIComponent(conversationId)}:`, `handoff:${conversationId}:`]
  return (sessionKey) => {
    const incoming = sessionKey.startsWith('a2a:') && directAgentIds.some(id => sessionKey.includes(`:bot:${encodeURIComponent(id)}:topic:`))
    return (incoming || prefixes.some(prefix => sessionKey.startsWith(prefix))) && (!topicId || sessionKey.includes(encodeURIComponent(topicId)))
  }
}
