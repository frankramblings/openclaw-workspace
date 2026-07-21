import { test, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { Message, Md } from './Message'
import type { Bubble } from './reducer'

// Mock the store and workspace store
vi.mock('./store', () => ({
  useChatStore: vi.fn(() => ({
    branchFromMessage: vi.fn(),
    regenerate: vi.fn(),
    continueFrom: vi.fn(),
  })),
}))

vi.mock('../../shell/workspace/store', () => ({
  useWorkspaceStore: vi.fn(() => ({
    openPath: vi.fn(),
  })),
}))

vi.mock('../../lib/enhance', () => ({
  enhanceMessageEl: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

const mockBubble: Bubble = {
  id: 'test-1',
  role: 'assistant',
  text: 'Test message',
  thinking: '',
  cards: [],
  images: [],
}

test('Md component renders markdown with delegated click handler', () => {
  const { container } = render(<Md src="# Title" />)
  const mdDiv = container.querySelector('.msg-markdown')
  expect(mdDiv).not.toBeNull()
})

test('codeCopy action is wired in delegation handler', () => {
  const { container } = render(
    <Md src="```js\nconst x = 1\n```" />
  )

  // The code-card should be rendered
  const codeCard = container.querySelector('.code-card')
  expect(codeCard).not.toBeNull()

  // The copy button should exist in the markup
  const copyBtn = codeCard?.querySelector('.copy')
  expect(copyBtn).not.toBeNull()
})

test('codeCopy writes the raw text (textContent), not markup, and swaps the label then restores it', async () => {
  vi.useFakeTimers()
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.assign(navigator, { clipboard: { writeText } })

  const { container } = render(<Md src={'```js\nconst x = 1 < 2;\n```'} />)
  const codeCard = container.querySelector('.code-card')!
  const codeEl = codeCard.querySelector('code')!
  // Simulate post-highlight DOM: nested spans, as hljs.highlightElement would
  // leave behind. textContent must still yield the plain source text.
  codeEl.innerHTML = '<span class="hljs-keyword">const</span> x = 1 &lt; 2;'
  const copyBtn = codeCard.querySelector('.copy') as HTMLButtonElement

  fireEvent.click(copyBtn)
  await vi.waitFor(() => expect(writeText).toHaveBeenCalled())
  expect(writeText).toHaveBeenCalledWith('const x = 1 < 2;')
  expect(writeText.mock.calls[0][0]).not.toMatch(/<span/)

  await vi.waitFor(() => expect(copyBtn.textContent).toBe('Copied'))
  vi.advanceTimersByTime(1500)
  expect(copyBtn.textContent).toBe('Copy')
  vi.useRealTimers()
})

test('codeCopy concurrent clicks: rapid second click does not leave the label permanently stuck on "Copied"', async () => {
  vi.useFakeTimers()
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.assign(navigator, { clipboard: { writeText } })

  const { container } = render(<Md src={'```js\nconst x = 1\n```'} />)
  const copyBtn = container.querySelector('.copy') as HTMLButtonElement

  fireEvent.click(copyBtn)
  await vi.waitFor(() => expect(copyBtn.textContent).toBe('Copied'))

  // Second click fires while the label is already "Copied" (before the
  // first restore timer runs) — must not capture "Copied" as the restore
  // target for its own timer.
  fireEvent.click(copyBtn)
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))

  vi.advanceTimersByTime(2000) // past both timers
  expect(copyBtn.textContent).toBe('Copy')
  vi.useRealTimers()
})

test('codeExpand action removes collapsed class and hides the button on click', () => {
  const lines = Array.from({ length: 35 }, (_, i) => `line ${i + 1}`).join('\n')
  const src = '```\n' + lines + '\n```'
  const { container } = render(<Md src={src} />)

  const codeCard = container.querySelector('.code-card.collapsed')!
  expect(codeCard).not.toBeNull()
  const expandBtn = codeCard.querySelector('.code-expand') as HTMLButtonElement
  expect(expandBtn).not.toBeNull()

  fireEvent.click(expandBtn)

  expect(codeCard.classList.contains('collapsed')).toBe(false)
  expect(codeCard.querySelector('.code-expand')).toBeNull()
})

test('unknown data-act values are ignored (no throw, no side effect)', () => {
  const { container } = render(<Md src="hello" />)
  const md = container.querySelector('.msg-markdown')!
  const stray = document.createElement('button')
  stray.setAttribute('data-act', 'somethingElse')
  md.appendChild(stray)
  expect(() => fireEvent.click(stray)).not.toThrow()
})

test('wsOpenFile action still works (regression): click calls openPath with the file arg', async () => {
  const openPath = vi.fn()
  const useWorkspaceStoreMock = await import('../../shell/workspace/store')
  vi.mocked(useWorkspaceStoreMock.useWorkspaceStore).mockImplementation((selector: any) => selector({ openPath }))

  const { container } = render(<Md src="[file](~/.openclaw/workspace/project-notes.md)" />)
  const fileLink = container.querySelector('[data-act="wsOpenFile"]') as HTMLElement
  expect(fileLink).not.toBeNull()

  fireEvent.click(fileLink)
  expect(openPath).toHaveBeenCalledWith('project-notes.md', undefined)
})

test('Message component passes streaming prop to Md', () => {
  const { container } = render(
    <Message bubble={mockBubble} streaming={true} />
  )
  expect(container).not.toBeNull()
})
