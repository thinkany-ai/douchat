export interface BotMember {
  id: string
  name: string
  description?: string
}

/** Exclude code, quoted replies, links and email addresses from mention labels. */
function routingText(content: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ')
  let fence = ''
  const prose = content
    .split('\n')
    .map((line) => {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)
      if (marker) {
        if (!fence) fence = marker[1]
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = ''
        return blank(line)
      }
      return fence ? blank(line) : line
    })
    .join('\n')
  return prose
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/^\s*>.*$/gm, blank)
    .replace(/\[[^\]]*\]\([^)]*\)/g, blank)
}

const normalizeName = (value: string): string => value.normalize('NFKC').toLocaleLowerCase()
const mentionBoundary = (value: string): boolean =>
  !value || /[\s,，.。!！?？:：;；、()（）[\]{}<>"“”'‘’「」]/u.test(value)

/** Longest names win, so @Ann never accidentally addresses @Anna. */
export function mentionedMembers<T extends BotMember>(content: string, members: T[]): T[] {
  const text = normalizeName(routingText(content))
  const candidates = [...members].filter((member) => member.name.trim()).sort((a, b) => b.name.length - a.name.length)
  const result = new Set<string>()
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '@' || !mentionBoundary(text[index - 1] ?? '')) continue
    const match = candidates.find((member) => {
      const name = normalizeName(member.name)
      return text.startsWith(name, index + 1) && mentionBoundary(text[index + 1 + name.length] ?? '')
    })
    if (match) {
      result.add(match.id)
      index += normalizeName(match.name).length
    }
  }
  return [...result].flatMap((id) => members.filter((member) => member.id === id))
}

export function addressesEveryone(content: string): boolean {
  return /(?:^|[\s,，、])@(?:all|everyone|所有成员|所有人|全体成员|大家)(?=$|[\s,，.。!！?？:：;；、])/iu.test(
    routingText(content).normalize('NFKC')
  )
}

/** An explicit address (including an unknown member) must not inherit a recipient. */
export function hasExplicitMention(content: string): boolean {
  const text = routingText(content).normalize('NFKC')
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '@' && mentionBoundary(text[index - 1] ?? '')) return true
  }
  return false
}

export interface MentionQuery {
  start: number
  end: number
  query: string
}

/** Keep spaces in the query: names such as “我的 codex” are valid members. */
export function mentionQuery(value: string, cursor: number, members: BotMember[] = []): MentionQuery | null {
  const before = value.slice(0, cursor)
  const start = before.lastIndexOf('@')
  if (start < 0 || !mentionBoundary(before[start - 1] ?? '')) return null
  const query = before.slice(start + 1)
  if (query.length > 80 || /[\n@,，。!！?？:：;；]/u.test(query)) return null
  // Once a complete mention is followed by a space, normal message typing
  // resumes; keep supporting spaces while a member's name is incomplete.
  const normalized = normalizeName(query)
  const continuingName = members.some((member) => normalizeName(member.name).startsWith(normalized))
  if (
    !continuingName &&
    ['all', 'everyone', ...members.map((member) => member.name)].some((name) => {
      const complete = normalizeName(name)
      return normalized.startsWith(complete) && /\s/.test(normalized[complete.length] ?? '')
    })
  )
    return null
  return { start, end: cursor, query }
}

export function insertMention(value: string, query: MentionQuery, name: string): { value: string; cursor: number } {
  const mention = `@${name} `
  return {
    value: value.slice(0, query.start) + mention + value.slice(query.end),
    cursor: query.start + mention.length
  }
}


export interface SelectedMention { id: string; name: string; start: number; end: number }

/** Preserve selected IDs through edits outside their text; editing a mention invalidates it. */
export function updateSelectedMentions(before: string, after: string, mentions: SelectedMention[]): SelectedMention[] {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let oldEnd = before.length, newEnd = after.length
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd-- }
  return mentions.flatMap(mention => {
    if (mention.end <= start) return [mention]
    if (mention.start >= oldEnd) return [{ ...mention, start: mention.start + newEnd - oldEnd, end: mention.end + newEnd - oldEnd }]
    return []
  }).filter(mention => after.slice(mention.start, mention.end) === `@${mention.name}`)
}

export function resolveMentionedMembers<T extends BotMember>(content: string, members: T[], selections: SelectedMention[] = []): T[] {
  if (!Array.isArray(selections) || selections.length > 100) throw new Error('Invalid selected mentions')
  let remaining = routingText(content)
  const selected: T[] = []
  for (const mention of selections) {
    if (!mention || typeof mention.id !== 'string' || typeof mention.name !== 'string' || !Number.isInteger(mention.start) || !Number.isInteger(mention.end) || mention.start < 0 || mention.end > content.length || mention.end <= mention.start) throw new Error('Invalid selected mention')
    if (remaining.slice(mention.start, mention.end) !== `@${mention.name}` || !mentionBoundary(remaining[mention.start - 1] ?? '') || !mentionBoundary(remaining[mention.end] ?? '')) continue
    const member = members.find(member => member.id === mention.id)
    if (!member) throw new Error('The selected member is no longer in this group. Select them again.')
    selected.push(member)
    remaining = remaining.slice(0, mention.start) + ' '.repeat(mention.end - mention.start) + remaining.slice(mention.end)
  }
  const typed = mentionedMembers(remaining, members)
  if (typed.some(member => members.filter(other => normalizeName(other.name) === normalizeName(member.name)).length > 1)) throw new Error('This mention matches multiple members. Use a unique member name or select a task recipient.')
  return [...new Map([...selected, ...typed].map(member => [member.id, member])).values()]
}

/** The members that may answer a group message: everyone allowed to join in
 *  on their own, plus the mention-only members it @mentions (or @everyone). */
export function mentionOnlyFilter<T extends BotMember>(
  members: T[],
  mentionOnly: string[],
  content: string,
  recipients?: { id: string }[]
): T[] {
  if (!mentionOnly.length) return members
  const quiet = new Set(mentionOnly)
  const addressed = new Set((recipients ?? []).map(item => item.id))
  for (const member of addressesEveryone(content) ? members : mentionedMembers(content, members)) addressed.add(member.id)
  return members.filter(member => !quiet.has(member.id) || addressed.has(member.id))
}
