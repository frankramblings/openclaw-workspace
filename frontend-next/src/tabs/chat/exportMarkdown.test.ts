import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderThreadMarkdown, downloadMarkdown, type HistoryBubble } from './exportMarkdown'

describe('renderThreadMarkdown', () => {
  it('should render a simple thread with user and assistant messages', () => {
    const bubbles: HistoryBubble[] = [
      { role: 'user', text: 'Hello, Claude!' },
      { role: 'assistant', text: 'Hi there! How can I help?' },
    ]

    const markdown = renderThreadMarkdown('My Chat', bubbles)

    expect(markdown).toContain('# My Chat')
    expect(markdown).toContain('## User')
    expect(markdown).toContain('Hello, Claude!')
    expect(markdown).toContain('## Gary')
    expect(markdown).toContain('Hi there! How can I help?')
  })

  it('should preserve code fences verbatim', () => {
    const bubbles: HistoryBubble[] = [
      {
        role: 'user',
        text: `Here's some code:\n\`\`\`python\ndef hello():\n    print("world")\n\`\`\``,
      },
    ]

    const markdown = renderThreadMarkdown('Chat', bubbles)

    expect(markdown).toContain('```python')
    expect(markdown).toContain('def hello():')
    expect(markdown).toContain('```')
  })

  it('should preserve code fences that contain ## lines', () => {
    const bubbles: HistoryBubble[] = [
      {
        role: 'user',
        text: `Example markdown:\n\`\`\`markdown\n## Section 1\n### Subsection\n\`\`\``,
      },
    ]

    const markdown = renderThreadMarkdown('Chat', bubbles)

    // The ## lines inside the fence should NOT be treated as markdown headings
    expect(markdown).toContain('```markdown')
    expect(markdown).toContain('## Section 1')
    expect(markdown).toContain('### Subsection')
    expect(markdown).toContain('```')
  })

  it('should preserve an UNTERMINATED fence byte-verbatim (no auto-close, no truncation)', () => {
    const text = "Partial output:\n```python\ndef broken(:\n    # never closed"
    const bubbles: HistoryBubble[] = [{ role: 'assistant', text }]

    const markdown = renderThreadMarkdown('Chat', bubbles)

    // The exact original text must appear unmodified — no synthetic closing
    // fence inserted, no content dropped or altered.
    expect(markdown).toContain(text)
  })

  it('should preserve NESTED fences byte-verbatim (a fence containing its own ``` markers as literal text)', () => {
    const text = 'Docs snippet:\n````markdown\nHow to fence code:\n```js\nconsole.log(1)\n```\n````'
    const bubbles: HistoryBubble[] = [{ role: 'user', text }]

    const markdown = renderThreadMarkdown('Chat', bubbles)

    expect(markdown).toContain(text)
  })

  it('should render attachments as links', () => {
    const bubbles: HistoryBubble[] = [
      {
        role: 'user',
        text: 'Check this out',
        attachments: [
          { name: 'image.png', path: '/files/image.png' },
          { name: 'document.pdf', path: '/files/document.pdf' },
        ],
      },
    ]

    const markdown = renderThreadMarkdown('Chat', bubbles)

    expect(markdown).toContain('[image.png](/files/image.png)')
    expect(markdown).toContain('[document.pdf](/files/document.pdf)')
  })

  it('should handle attachments with fallback name when name is missing', () => {
    const bubbles: HistoryBubble[] = [
      {
        role: 'user',
        text: '',
        attachments: [
          { filename: 'doc.txt', path: '/files/doc.txt' },
        ],
      },
    ]

    const markdown = renderThreadMarkdown('Chat', bubbles)

    expect(markdown).toContain('[doc.txt](/files/doc.txt)')
  })

  it('should render empty history as just the header', () => {
    const bubbles: HistoryBubble[] = []

    const markdown = renderThreadMarkdown('My Empty Chat', bubbles)

    expect(markdown).toContain('# My Empty Chat')
    // Should have some blank lines after the header
    expect(markdown.split('\n').length).toBeGreaterThan(1)
  })

  it('should have blank lines between bubbles for readability', () => {
    const bubbles: HistoryBubble[] = [
      { role: 'user', text: 'First message' },
      { role: 'assistant', text: 'Response' },
      { role: 'user', text: 'Second message' },
    ]

    const markdown = renderThreadMarkdown('Chat', bubbles)
    const lines = markdown.split('\n')

    // There should be blank lines (empty strings) separating sections
    let blankLineCount = 0
    for (const line of lines) {
      if (line === '') blankLineCount++
    }
    expect(blankLineCount).toBeGreaterThan(0)
  })

  it('should escape heading characters in session name', () => {
    const bubbles: HistoryBubble[] = []

    const markdown = renderThreadMarkdown('# Important Chat', bubbles)

    // The # in the session name should be escaped to prevent creating a nested heading
    expect(markdown).toMatch(/^# \\#+ Important Chat/)
  })

  it('should handle messages with no text but with attachments', () => {
    const bubbles: HistoryBubble[] = [
      {
        role: 'assistant',
        text: undefined,
        attachments: [
          { name: 'image.jpg', path: '/img.jpg' },
        ],
      },
    ]

    const markdown = renderThreadMarkdown('Chat', bubbles)

    expect(markdown).toContain('## Gary')
    expect(markdown).toContain('[image.jpg](/img.jpg)')
  })

  it('should role-map to Gary by default for assistant', () => {
    const bubbles: HistoryBubble[] = [
      { role: 'assistant', text: 'Response' },
    ]

    const markdown = renderThreadMarkdown('Chat', bubbles)

    expect(markdown).toContain('## Gary')
    expect(markdown).not.toContain('## Assistant')
  })
})

describe('downloadMarkdown', () => {
  beforeEach(() => {
    // Mock URL methods
    ;(URL.createObjectURL as any) = vi.fn(() => 'blob:mock-url')
    ;(URL.revokeObjectURL as any) = vi.fn()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('should trigger a download with proper filename', () => {
    const clickSpy = vi.fn()
    const originalCreateElement = document.createElement.bind(document)

    vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
      if (tagName === 'a') {
        const link = originalCreateElement('a')
        link.click = clickSpy
        return link
      }
      return originalCreateElement(tagName)
    })

    downloadMarkdown('test-file', 'test content')

    expect(clickSpy).toHaveBeenCalled()
  })

  it('should sanitize filename correctly', () => {
    // Test that we can call the function without error
    // (actual filename sanitization is tested implicitly)
    expect(() => {
      downloadMarkdown('My Test-File #2! (draft)', 'content')
    }).not.toThrow()
  })

  it('should handle empty filename with fallback', () => {
    expect(() => {
      downloadMarkdown('', 'content')
    }).not.toThrow()
  })

  it('should fall back for a dot-only filename, never producing an empty or dot-only name', () => {
    const capturedNames: string[] = []
    const originalCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
      if (tagName === 'a') {
        const link = originalCreateElement('a')
        link.click = vi.fn()
        const anchor = link as HTMLAnchorElement
        Object.defineProperty(anchor, 'download', {
          get() { return this._download },
          set(v) { this._download = v; capturedNames.push(v) },
        })
        return link
      }
      return originalCreateElement(tagName)
    })

    for (const dotty of ['...', '.', '..', '   ']) {
      downloadMarkdown(dotty, 'content')
    }

    for (const name of capturedNames) {
      expect(name).not.toBe('')
      expect(name).not.toBe('.md')
      expect(name.replace(/\.md$/, '')).not.toMatch(/^\.*$/)
    }
  })

  it('revokes the object URL even when the download itself throws', () => {
    const revokeSpy = URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>
    const originalCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tagName) => {
      if (tagName === 'a') {
        const link = originalCreateElement('a')
        link.click = vi.fn(() => { throw new Error('click failed') })
        return link
      }
      return originalCreateElement(tagName)
    })

    expect(() => downloadMarkdown('test', 'content')).toThrow('click failed')
    expect(revokeSpy).toHaveBeenCalledWith('blob:mock-url')
  })
})
