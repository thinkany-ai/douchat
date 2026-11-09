import { CalendarClock, MonitorSmartphone, Plug } from 'lucide-react'
import type { ReactElement } from 'react'
import { CONNECTORS_ENABLED } from '../../../shared/connany'
import type { AgentConfig, Conversation, LocalAgent, Routine, TaskRun } from '../../../shared/types'
import { t } from '../preferences'
import { AutomationPanel } from './AutomationPanel'
import { ConnanyPanel } from './ConnanyPanel'
import { DevicesPanel } from './DevicesPanel'
import { SidebarResizer } from './common'

export type DiscoverPage = 'automation' | 'connectors' | 'devices'

/** The pages Discover offers here; connectors only where they are enabled. */
export const discoverPages = (): DiscoverPage[] => CONNECTORS_ENABLED ? ['automation', 'connectors', 'devices'] : ['automation', 'devices']

const pageInfo: Record<DiscoverPage, { label: string; icon: typeof Plug }> = {
  automation: { label: 'Automation', icon: CalendarClock },
  connectors: { label: 'Connectors', icon: Plug },
  devices: { label: 'Devices & Environments', icon: MonitorSmartphone }
}

/** Discover's list column: what agents can do beyond chatting. */
export function DiscoverSidebar({ page, onSelect }: {
  page: DiscoverPage
  onSelect: (page: DiscoverPage) => void
}): ReactElement {
  return (
    <aside className="sidebar discover-sidebar">
      <SidebarResizer />
      <div className="sidebar-titlebar window-drag"><div className="wordmark">{t('Discover')}</div></div>
      <nav className="discover-list" aria-label={t('Discover')}>
        {discoverPages().map((item) => {
          const { label, icon: Icon } = pageInfo[item]
          return (
            <button key={item} type="button" className={`discover-item ${page === item ? 'active' : ''}`} aria-current={page === item} onClick={() => onSelect(item)}>
              <Icon className={`discover-item-icon ${item}`} size={22} strokeWidth={1.8} aria-hidden="true" />
              <span className="discover-item-label">{t(label)}</span>
            </button>
          )
        })}
      </nav>
    </aside>
  )
}

/** The selected Discover page, in the main column. */
export function DiscoverContent({ page, userId, userName, userAvatar, routines, runs, agents, conversations, localAgents = [], onLocalAgentsChange, onShowLocalAgents, onDeleteRoutine, onSetRoutineEnabled, onRunRoutineNow }: {
  page: DiscoverPage
  userId: string
  userName: string
  userAvatar: string
  routines: Routine[]
  runs: TaskRun[]
  agents: AgentConfig[]
  conversations: Conversation[]
  /** Agent programs on this computer and other machines (Settings → Agents). */
  localAgents?: LocalAgent[]
  onLocalAgentsChange?: (agents: LocalAgent[]) => void
  /** Shows Settings → Agents on one device or server. */
  onShowLocalAgents?: (connectionId: string) => void
  onDeleteRoutine: (id: string) => Promise<void>
  onSetRoutineEnabled: (id: string, enabled: boolean) => Promise<void>
  onRunRoutineNow: (id: string) => Promise<void>
}): ReactElement {
  return (
    <main className="workspace discover-workspace">
      <div className="settings-content discover-content">
        {page === 'devices'
          ? <DevicesPanel key={userId} agents={localAgents} onAgentsChange={list => onLocalAgentsChange?.(list)} onShowAgents={onShowLocalAgents} />
          : page === 'connectors' && CONNECTORS_ENABLED
          ? <ConnanyPanel key={userId} />
          : <AutomationPanel routines={routines} runs={runs} agents={agents} conversations={conversations} userName={userName} userAvatar={userAvatar}
              onDelete={onDeleteRoutine} onSetEnabled={onSetRoutineEnabled} onRunNow={onRunRoutineNow} />}
      </div>
    </main>
  )
}
