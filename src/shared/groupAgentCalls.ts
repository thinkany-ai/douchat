const DIRECTIVE =
  /\[\[douchat_call_group_agent\]\]([\s\S]*?)(?:\[\[\/douchat_call_group_agent\]\]|(?=\[\[douchat_call_group_agent\]\])|$)/g;

/** Consume every call, including malformed/truncated blocks, before publishing. */
export function parseGroupAgentReply(raw: string): {
  reply: string;
  delegates: { agentId: string; message: string }[];
} {
  const delegates: { agentId: string; message: string }[] = [];
  const seen = new Set<string>();
  const reply = raw.replace(DIRECTIVE, (_block, json: string) => {
    try {
      const parsed = JSON.parse(json.trim());
      const agentId = typeof parsed?.agentId === 'string' ? parsed.agentId.trim() : '';
      if (agentId && !seen.has(agentId)) {
        delegates.push({ agentId, message: typeof parsed.message === 'string' ? parsed.message.trim() : '' });
        seen.add(agentId);
      }
    } catch { /* Internal protocol fragments never belong in the transcript. */ }
    return '';
  }).replace(/\[\[\/douchat_call_group_agent\]\]/g, '').trim();
  return { reply: reply || 'Task completed.', delegates };
}
