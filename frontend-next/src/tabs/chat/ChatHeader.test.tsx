import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChatHeader } from './ChatHeader'
import { useChatStore } from './store'
import type { Bubble } from './reducer'
import type { SessionRecord } from './types'

afterEach(cleanup)

const sessionA: SessionRecord = {
  id: 'a', name: 'Session A', model: 'gpt-test', speed: 'deep',
  sessionKey: 'agent:main:web-a', endpoint_url: 'ws://localhost', endpoint_id: 'openai',
  folder: null, archived: false, important: false, created: 1, updated: 2,
  origin: null, gary_terminal: null,
}
const sessionB: SessionRecord = { ...sessionA, id: 'b', name: 'Session B' }

const bubble = (id: string, text: string): Bubble => ({
  id, role: 'user', text, thinking: '', cards: [], images: [],
})

function baseState(overrides: Partial<ReturnType<typeof useChatStore.getState>>) {
  useChatStore.setState({
    sessions: { status: 'ready', data: [sessionA, sessionB], fetchedAt: 1 },
    branchPrefix: null,
    liveTurn: null,
    ...overrides,
  })
}

test('export/copy affordances are enabled once history is ready with messages', () => {
  baseState({
    activeSessionId: 'a',
    history: { status: 'ready', data: [bubble('1', 'hi')], fetchedAt: 1 },
  })
  render(<ChatHeader />)
  expect((screen.getByRole('button', { name: 'Markdown' }) as HTMLButtonElement).disabled).toBe(false)
  expect((screen.getByRole('button', { name: 'Copy transcript' }) as HTMLButtonElement).disabled).toBe(false)
  expect((screen.getByRole('button', { name: 'PDF' }) as HTMLButtonElement).disabled).toBe(false)
})

test('export/copy affordances are disabled while history has never loaded', () => {
  baseState({
    activeSessionId: 'a',
    history: { status: 'idle' },
  })
  render(<ChatHeader />)
  expect((screen.getByRole('button', { name: 'Markdown' }) as HTMLButtonElement).disabled).toBe(true)
})

test('export/copy affordances stay disabled mid session-switch even though stale bubbles from the PREVIOUS session are non-empty', () => {
  // Regression: loadHistory() sets history to {status:'loading', stale:
  // <previous session's already-loaded data>} for a render or two while
  // switching sessions. The header must not treat that leftover data as
  // "ready to export" under the NEW session's title — see the comment in
  // ChatHeader.tsx above `historyReady`.
  baseState({
    activeSessionId: 'b', // header title already shows Session B
    history: { status: 'loading', stale: [bubble('1', 'session A message')] },
  })
  render(<ChatHeader />)
  expect(screen.getByRole('heading', { name: 'Session B' })).toBeTruthy()
  expect((screen.getByRole('button', { name: 'Markdown' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'Copy transcript' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'PDF' }) as HTMLButtonElement).disabled).toBe(true)
})

test('export/copy affordances are disabled when history is ready but genuinely empty', () => {
  baseState({
    activeSessionId: 'a',
    history: { status: 'ready', data: [], fetchedAt: 1 },
  })
  render(<ChatHeader />)
  expect((screen.getByRole('button', { name: 'Markdown' }) as HTMLButtonElement).disabled).toBe(true)
})
