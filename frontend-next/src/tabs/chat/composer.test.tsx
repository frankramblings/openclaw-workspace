import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Composer } from './Composer'
import { emptyTurn } from './reducer'
import { useChatStore } from './store'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('an empty suggestion response renders no ghost text', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ text: '' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })))
  useChatStore.setState({
    activeSessionId: 'one',
    history: { status: 'ready', data: [{
      id: 'h', role: 'assistant', text: 'Done', thinking: '', cards: [], images: [],
    }], fetchedAt: 1 },
    liveTurn: { ...emptyTurn(), turnId: 7, status: 'done' },
  })
  render(<Composer />)

  await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
  expect(document.querySelector('.ghost-suggest')).toBeNull()
})

test('working turns expose Stop instead of Send', () => {
  useChatStore.setState({
    activeSessionId: 'one',
    history: { status: 'ready', data: [], fetchedAt: 1 },
    liveTurn: { ...emptyTurn(), status: 'streaming' },
  })
  render(<Composer />)
  expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
})

// Regression (2026-07-16 live smoke): clicking "New chat" and sending straight
// away silently re-homed the message to the PREVIOUS conversation. createSession
// is async, so the composer stayed enabled on the outgoing session; send()
// buffered against it, activeSessionId flipped to the new session mid-grace, and
// flushPending's mismatch branch parked the message in the old session's queue.
// The new chat rendered "No messages yet" while the text sat behind a dot
// elsewhere. Sending must be blocked while a session creation is in flight.
test('Send is blocked while a new session is being created', () => {
  useChatStore.setState({
    activeSessionId: 'previous-session',
    history: { status: 'ready', data: [], fetchedAt: 1 },
    liveTurn: null,
    pendingSessions: { new: 'creating' },
  })
  render(<Composer />)
  const textarea = document.querySelector('.composer textarea') as HTMLTextAreaElement
  fireEvent.change(textarea, { target: { value: 'ping' } })
  // A typed draft would normally enable Send; the in-flight creation must not.
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
})

test('Send is available again once session creation settles', () => {
  useChatStore.setState({
    activeSessionId: 'new-session',
    history: { status: 'ready', data: [], fetchedAt: 1 },
    liveTurn: null,
    pendingSessions: {},
  })
  render(<Composer />)
  const textarea = document.querySelector('.composer textarea') as HTMLTextAreaElement
  fireEvent.change(textarea, { target: { value: 'ping' } })
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
})
