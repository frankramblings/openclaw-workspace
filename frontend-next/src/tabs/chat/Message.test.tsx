import { test, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { Message, Md } from './Message'
import type { Bubble } from './reducer'

// Mock the store and workspace store
vi.mock('./store', () => ({
  useChatStore: vi.fn((selector) => {
    const mockState = {
      branchFromMessage: vi.fn(),
      regenerate: vi.fn(),
      continueFrom: vi.fn(),
      editingMessageId: null,
      startEdit: vi.fn(),
      cancelEdit: vi.fn(),
      editMessage: vi.fn(),
      models: { status: 'idle' as const },
      activeSessionId: null,
      sessions: { status: 'idle' as const },
    }
    return typeof selector === 'function' ? selector(mockState) : mockState
  }),
}))

// Shape used by several tests below to override the mocked chat store per-test.
type MockChatState = {
  branchFromMessage: ReturnType<typeof vi.fn>
  regenerate: ReturnType<typeof vi.fn>
  continueFrom: ReturnType<typeof vi.fn>
  editingMessageId: string | null
  startEdit: ReturnType<typeof vi.fn>
  cancelEdit: ReturnType<typeof vi.fn>
  editMessage: ReturnType<typeof vi.fn>
  models: { status: 'idle' } | { status: 'ready'; data: Array<{ endpoint_id: string; endpoint_name: string; url: string; category: string; model_type: string; offline: boolean; models: string[]; models_display: string[] }> }
  activeSessionId: string | null
  sessions: { status: 'idle' } | { status: 'ready'; data: Array<{ id: string; model: string }> }
}

async function mockStoreState(overrides: Partial<MockChatState>) {
  const base: MockChatState = {
    branchFromMessage: vi.fn(),
    regenerate: vi.fn().mockResolvedValue(true),
    continueFrom: vi.fn(),
    editingMessageId: null,
    startEdit: vi.fn(),
    cancelEdit: vi.fn(),
    editMessage: vi.fn().mockResolvedValue(true),
    models: { status: 'idle' },
    activeSessionId: null,
    sessions: { status: 'idle' },
  }
  const state = { ...base, ...overrides }
  const storeModule = await import('./store')
  vi.mocked(storeModule.useChatStore).mockImplementation((selector: any) => (typeof selector === 'function' ? selector(state) : state))
  return state
}

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

test('Message component shows pencil tool for user messages', () => {
  const userBubble: Bubble = {
    id: 'test-1',
    role: 'user',
    text: 'Test user message',
    thinking: '',
    cards: [],
    images: [],
  }
  const { container } = render(
    <Message bubble={userBubble} />
  )
  const editButton = Array.from(container.querySelectorAll('.msg-tool')).find(
    el => el.getAttribute('title') === 'Edit message'
  )
  expect(editButton).not.toBeNull()
})

test('Message component does not show pencil tool for assistant messages', () => {
  const { container } = render(
    <Message bubble={mockBubble} />
  )
  const editButton = Array.from(container.querySelectorAll('.msg-tool')).find(
    el => el.getAttribute('title') === 'Edit message'
  )
  expect(editButton).toBeUndefined()
})

test('Message component does not show a retry menu for user messages', () => {
  const userBubble: Bubble = { id: 'u1', role: 'user', text: 'hi', thinking: '', cards: [], images: [] }
  const { container } = render(<Message bubble={userBubble} />)
  expect(container.querySelector('[title="Retry options"]')).toBeNull()
  expect(container.querySelector('.msg-retry-menu')).toBeNull()
})

// ---- Edit mode (UNIT-201) ----

test('edit mode: clicking the pencil swaps in a textarea prefilled with the bubble text', async () => {
  const userBubble: Bubble = { id: 'u1', role: 'user', text: 'original text', thinking: '', cards: [], images: [] }
  await mockStoreState({ editingMessageId: null })
  const { container, rerender } = render(<Message bubble={userBubble} />)
  const editButton = Array.from(container.querySelectorAll('.msg-tool')).find(el => el.getAttribute('title') === 'Edit message') as HTMLButtonElement
  fireEvent.click(editButton)

  // startEdit was invoked; simulate the store now reflecting edit mode active
  await mockStoreState({ editingMessageId: 'u1' })
  rerender(<Message bubble={userBubble} />)

  const textarea = container.querySelector('.msg-edit-ta') as HTMLTextAreaElement
  expect(textarea).not.toBeNull()
  expect(textarea.value).toBe('original text')
})

test('edit mode: Save is disabled when text is empty and there are no attachments', async () => {
  const userBubble: Bubble = { id: 'u1', role: 'user', text: 'original text', thinking: '', cards: [], images: [] }
  await mockStoreState({ editingMessageId: 'u1' })
  const { container } = render(<Message bubble={userBubble} />)
  const textarea = container.querySelector('.msg-edit-ta') as HTMLTextAreaElement
  fireEvent.change(textarea, { target: { value: '   ' } })
  const saveBtn = container.querySelector('.msg-edit-save') as HTMLButtonElement
  expect(saveBtn.disabled).toBe(true)
})

test('edit mode: Save is enabled (and calls editMessage with the typed text) when text is non-empty', async () => {
  const userBubble: Bubble = { id: 'u1', role: 'user', text: 'original text', thinking: '', cards: [], images: [] }
  const state = await mockStoreState({ editingMessageId: 'u1' })
  const { container } = render(<Message bubble={userBubble} />)
  const textarea = container.querySelector('.msg-edit-ta') as HTMLTextAreaElement
  fireEvent.change(textarea, { target: { value: 'edited text' } })
  const saveBtn = container.querySelector('.msg-edit-save') as HTMLButtonElement
  expect(saveBtn.disabled).toBe(false)
  fireEvent.click(saveBtn)
  await vi.waitFor(() => expect(state.editMessage).toHaveBeenCalledWith('u1', 'edited text'))
})

test('edit mode: Cmd/Ctrl+Enter in the textarea saves', async () => {
  const userBubble: Bubble = { id: 'u1', role: 'user', text: 'original text', thinking: '', cards: [], images: [] }
  const state = await mockStoreState({ editingMessageId: 'u1' })
  const { container } = render(<Message bubble={userBubble} />)
  const textarea = container.querySelector('.msg-edit-ta') as HTMLTextAreaElement
  fireEvent.change(textarea, { target: { value: 'edited via shortcut' } })
  fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
  await vi.waitFor(() => expect(state.editMessage).toHaveBeenCalledWith('u1', 'edited via shortcut'))
})

test('edit mode: Escape in the textarea cancels and restores original rendering (does not call editMessage)', async () => {
  const userBubble: Bubble = { id: 'u1', role: 'user', text: 'original text', thinking: '', cards: [], images: [] }
  const state = await mockStoreState({ editingMessageId: 'u1' })
  const { container } = render(<Message bubble={userBubble} />)
  const textarea = container.querySelector('.msg-edit-ta') as HTMLTextAreaElement
  fireEvent.change(textarea, { target: { value: 'discard me' } })
  fireEvent.keyDown(textarea, { key: 'Escape' })
  expect(state.cancelEdit).toHaveBeenCalled()
  expect(state.editMessage).not.toHaveBeenCalled()
})

test('edit mode: clicking Cancel calls cancelEdit without calling editMessage', async () => {
  const userBubble: Bubble = { id: 'u1', role: 'user', text: 'original text', thinking: '', cards: [], images: [] }
  const state = await mockStoreState({ editingMessageId: 'u1' })
  const { container } = render(<Message bubble={userBubble} />)
  const cancelBtn = Array.from(container.querySelectorAll('.msg-edit-bar .ocbtn')).find(el => el.textContent === 'Cancel') as HTMLButtonElement
  fireEvent.click(cancelBtn)
  expect(state.cancelEdit).toHaveBeenCalled()
  expect(state.editMessage).not.toHaveBeenCalled()
})

// ---- Retry-with-model menu (UNIT-202) ----

const modelsReady = {
  status: 'ready' as const,
  data: [{
    endpoint_id: 'openai', endpoint_name: 'OpenAI', url: '', category: 'chat', model_type: 'chat',
    offline: false, models: ['gpt-4', 'gpt-3.5'], models_display: ['GPT-4', 'GPT-3.5'],
  }],
}
const sessionsReady = { status: 'ready' as const, data: [{ id: 'chat-1', model: 'gpt-4' }] }

test('retry menu: closed by default, opens on clicking "Retry options", lists models from the same store.models source used by ModelPicker', async () => {
  await mockStoreState({ models: modelsReady, sessions: sessionsReady, activeSessionId: 'chat-1' })
  const { container } = render(<Message bubble={mockBubble} />)
  expect(container.querySelector('.msg-retry-menu')).toBeNull()

  const retryBtn = container.querySelector('[title="Retry options"]') as HTMLButtonElement
  fireEvent.click(retryBtn)

  const menu = container.querySelector('.msg-retry-menu')
  expect(menu).not.toBeNull()
  const items = Array.from(menu!.querySelectorAll('.msg-retry-item')).map(el => el.textContent)
  expect(items).toEqual(['Retry', 'GPT-4', 'GPT-3.5'])
})

test('retry menu: plain "Retry" calls regenerate with no opts (single-arg, byte-compatible)', async () => {
  const state = await mockStoreState({ models: modelsReady, sessions: sessionsReady, activeSessionId: 'chat-1' })
  const { container } = render(<Message bubble={mockBubble} />)
  fireEvent.click(container.querySelector('[title="Retry options"]') as HTMLButtonElement)
  const retryItem = Array.from(container.querySelectorAll('.msg-retry-item')).find(el => el.textContent === 'Retry') as HTMLButtonElement
  fireEvent.click(retryItem)
  expect(state.regenerate).toHaveBeenCalledWith(mockBubble.id)
  expect(state.regenerate).not.toHaveBeenCalledWith(mockBubble.id, expect.anything())
})

test('retry menu: selecting a model calls regenerate with {model, endpointId} and closes the menu', async () => {
  const state = await mockStoreState({ models: modelsReady, sessions: sessionsReady, activeSessionId: 'chat-1' })
  const { container } = render(<Message bubble={mockBubble} />)
  fireEvent.click(container.querySelector('[title="Retry options"]') as HTMLButtonElement)
  const modelItem = Array.from(container.querySelectorAll('.msg-retry-item')).find(el => el.textContent === 'GPT-3.5') as HTMLButtonElement
  fireEvent.click(modelItem)
  await vi.waitFor(() => expect(state.regenerate).toHaveBeenCalledWith(mockBubble.id, { model: 'gpt-3.5', endpointId: 'openai' }))
  expect(container.querySelector('.msg-retry-menu')).toBeNull()
})

test('retry menu: outside click closes the menu', async () => {
  await mockStoreState({ models: modelsReady, sessions: sessionsReady, activeSessionId: 'chat-1' })
  const { container } = render(<Message bubble={mockBubble} />)
  fireEvent.click(container.querySelector('[title="Retry options"]') as HTMLButtonElement)
  expect(container.querySelector('.msg-retry-menu')).not.toBeNull()
  fireEvent.mouseDown(document.body)
  expect(container.querySelector('.msg-retry-menu')).toBeNull()
})

test('retry menu: Escape key closes the menu', async () => {
  await mockStoreState({ models: modelsReady, sessions: sessionsReady, activeSessionId: 'chat-1' })
  const { container } = render(<Message bubble={mockBubble} />)
  fireEvent.click(container.querySelector('[title="Retry options"]') as HTMLButtonElement)
  expect(container.querySelector('.msg-retry-menu')).not.toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(container.querySelector('.msg-retry-menu')).toBeNull()
})
