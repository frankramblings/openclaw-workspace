import { afterEach, expect, test } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
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

function renderThreadUnpinned(status: 'streaming' | 'stalled' | 'error' | 'aborted' | 'sending') {
  useChatStore.setState({
    activeSessionId: 'one',
    history: { status: 'ready', data: [], fetchedAt: 1 },
    liveTurn: { ...emptyTurn(), status, bubbles: [bubble] },
  })
  const { container } = render(<Thread />)
  const section = container.querySelector('.chat-thread')!
  // Simulate a scrolled-up (unpinned) viewport, then fire the scroll event
  // useStickToBottom listens for so its pinned state actually flips to false
  // (jsdom gives every element scrollHeight/clientHeight/scrollTop of 0 by
  // default, which reads as pinned, so this has to be forced).
  Object.defineProperty(section, 'scrollHeight', { value: 1000, configurable: true })
  Object.defineProperty(section, 'clientHeight', { value: 500, configurable: true })
  Object.defineProperty(section, 'scrollTop', { value: 300, configurable: true })
  act(() => { section.dispatchEvent(new Event('scroll', { bubbles: true })) })
  return container
}

test('jump-bottom-pill shows only while unpinned during an active stream, not during stalled/error/aborted/sending', () => {
  const streaming = renderThreadUnpinned('streaming')
  expect(streaming.querySelector('.jump-bottom-pill')).not.toBeNull()
  cleanup()

  for (const status of ['stalled', 'error', 'aborted', 'sending'] as const) {
    const container = renderThreadUnpinned(status)
    expect(container.querySelector('.jump-bottom-pill')).toBeNull()
    cleanup()
  }
})
