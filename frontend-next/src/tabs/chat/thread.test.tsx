import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Message } from './Message'
import { Thread } from './Thread'
import { emptyTurn, type Bubble } from './reducer'
import { useChatStore } from './store'

afterEach(cleanup)

const bubble: Bubble = {
  id: 'a', role: 'assistant', text: '**Finished**', thinking: 'checking', images: [],
  cards: [{ toolId: 't', tool: 'bash', command: 'npm test', output: 'all pass', exitCode: 0, state: 'done' }],
}

test('Message renders markdown, thinking, and activity cards', () => {
  render(<Message bubble={bubble} />)
  expect(screen.getByText('Finished').tagName).toBe('STRONG')
  expect(screen.getByText('Thought process')).toBeTruthy()
  expect(screen.getByText('npm test')).toBeTruthy()
  expect(screen.getByText('all pass')).toBeTruthy()
})

test('Thread renders the observed stalled duration and fallback model', () => {
  useChatStore.setState({
    activeSessionId: 'one',
    history: { status: 'ready', data: [], fetchedAt: 1 },
    liveTurn: {
      ...emptyTurn(), status: 'stalled', stallSeconds: 31, modelFallback: 'backup-model', bubbles: [bubble],
    },
  })
  render(<Thread />)
  expect(screen.getByText(/31s silent/)).toBeTruthy()
  expect(screen.getByText(/using backup-model/)).toBeTruthy()
})
