// THE one shared file between tab teams. Each Wave-1 task changes exactly one
// line: its tab's Component, from the StubTab placeholder to the real one.
// Order = rail order = priority order from the plan.
import type { ComponentType } from 'react'
import { createElement } from 'react'
import { StubTab } from '../kit'
import { ChatTab } from './chat'
import { InboxTab } from './inbox'

export interface TabDef {
  id: string
  label: string
  /** Single glyph placeholder for the rail (icon set lands with each tab). */
  icon: string
  order: number
  Component: ComponentType
}

const stub = (id: string): ComponentType => () => createElement(StubTab, { tab: id })

/** The tab every unknown/empty route resolves to — shared by the router and
 *  tabById so the two fallbacks can never drift apart. */
export const DEFAULT_TAB = 'chat'

export const TABS: TabDef[] = [
  { id: 'chat', label: 'Chat', icon: '💬', order: 1, Component: ChatTab },
  { id: 'inbox', label: 'Inbox', icon: '📥', order: 2, Component: InboxTab },
  { id: 'email', label: 'Email', icon: '✉️', order: 3, Component: stub('email') },
  { id: 'calendar', label: 'Calendar', icon: '📅', order: 4, Component: stub('calendar') },
  { id: 'notes', label: 'Notes', icon: '📝', order: 5, Component: stub('notes') },
  { id: 'documents', label: 'Documents', icon: '📄', order: 6, Component: stub('documents') },
  { id: 'research', label: 'Research', icon: '🔎', order: 7, Component: stub('research') },
  { id: 'library', label: 'Library', icon: '📚', order: 8, Component: stub('library') },
  { id: 'cron', label: 'Cron', icon: '⏰', order: 9, Component: stub('cron') },
  { id: 'memory', label: 'Memory', icon: '🧠', order: 10, Component: stub('memory') },
  { id: 'skills', label: 'Skills', icon: '⚡', order: 11, Component: stub('skills') },
  { id: 'settings', label: 'Settings', icon: '⚙️', order: 12, Component: stub('settings') },
]

export function tabById(id: string): TabDef {
  return TABS.find((t) => t.id === id) ?? TABS.find((t) => t.id === DEFAULT_TAB)!
}
