import type { AgentExecutor } from '../shared/agentExecutor'
import { runLocalAgent, disposeLocalAgentSessions, resetLocalAgentConversation, releaseIdleLocalAgentConnections, releaseLocalAgentSession, prepareLocalAgentSession } from './localAgentRuntime'

/** Runs agents on this machine: the desktop's own, and the owner tasks a douchat-host claims. */
export const desktopAgentExecutor: AgentExecutor = {
  releaseIdleConnections: (...args) => releaseIdleLocalAgentConnections(...args),
  run: (config, { prompt, signal, images = [], ...options }) => runLocalAgent(config, prompt, signal, images, options),
  prepare: (...args) => prepareLocalAgentSession(...args),
  disposeAgent: agentId => disposeLocalAgentSessions(agentId),
  releaseSession: sessionKey => releaseLocalAgentSession(sessionKey),
  resetConversation: (...args) => resetLocalAgentConversation(...args)
}
