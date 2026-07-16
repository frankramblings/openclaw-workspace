import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
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
