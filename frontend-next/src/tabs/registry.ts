// THE one shared file between tab teams. Each Wave-1 task changes exactly one
// line: its tab's Component, from the StubTab placeholder to the real one.
// Order = rail order = priority order from the plan.
import type { ComponentType } from 'react'
import type { IconName } from '../kit/icons'
import { ChatTab } from './chat'
import { InboxTab } from './inbox'
import { EmailTab } from './email'
import { CalendarTab } from './calendar'
import { NotesTab } from './notes'
import { DocumentsTab } from './documents'
import { ResearchTab } from './research'
import { LibraryTab } from './library'
import { CronTab } from './cron'
import { MemoryTab } from './memory'
import { SkillsTab } from './skills'
import { SettingsTab } from './settings'

export interface TabDef {
  id: string
  label: string
  /** Classic line-icon key (src/kit/icons.tsx), rendered by the top bar. */
  icon: IconName
  order: number
  Component: ComponentType
}

/** The tab every unknown/empty route resolves to — shared by the router and
 *  tabById so the two fallbacks can never drift apart. */
export const DEFAULT_TAB = 'chat'

export const TABS: TabDef[] = [
  { id: 'chat', label: 'Chat', icon: 'chat', order: 1, Component: ChatTab },
  { id: 'inbox', label: 'Inbox', icon: 'inbox', order: 2, Component: InboxTab },
  { id: 'email', label: 'Email', icon: 'email', order: 3, Component: EmailTab },
  { id: 'calendar', label: 'Calendar', icon: 'calendar', order: 4, Component: CalendarTab },
  { id: 'notes', label: 'Notes', icon: 'notes', order: 5, Component: NotesTab },
  { id: 'documents', label: 'Documents', icon: 'file', order: 6, Component: DocumentsTab },
  { id: 'research', label: 'Research', icon: 'research', order: 7, Component: ResearchTab },
  { id: 'library', label: 'Library', icon: 'library', order: 8, Component: LibraryTab },
  { id: 'cron', label: 'Cron', icon: 'clock', order: 9, Component: CronTab },
  { id: 'memory', label: 'Memory', icon: 'archive', order: 10, Component: MemoryTab },
  { id: 'skills', label: 'Skills', icon: 'code', order: 11, Component: SkillsTab },
  { id: 'settings', label: 'Settings', icon: 'settings', order: 12, Component: SettingsTab },
]

export function tabById(id: string): TabDef {
  return TABS.find((t) => t.id === id) ?? TABS.find((t) => t.id === DEFAULT_TAB)!
}
