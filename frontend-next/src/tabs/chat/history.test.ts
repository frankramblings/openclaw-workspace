import { expect, test } from 'vitest'
import { parseHistory } from './history'

test('normalizes roles and string or block-array content', () => {
  expect(parseHistory([
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'Hi' }, { content: ' there' }] },
  ])).toMatchObject([
    { role: 'user', text: 'Hello' },
    { role: 'assistant', text: 'Hi\n there' },
  ])
})

test('uses the final non-empty round and reconstructs completed tool cards', () => {
  const [bubble] = parseHistory([{
    role: 'assistant',
    content: 'first round',
    metadata: {
      round_texts: ['first round', '', 'final answer'],
      tool_events: [
        { tool: 'read', command: 'README.md', output: 'contents', exit_code: 0 },
        { tool: 'bash', command: 'false', output: 'failed', exit_code: 1 },
      ],
    },
  }])

  expect(bubble.text).toBe('final answer')
  expect(bubble.cards).toEqual([
    expect.objectContaining({ tool: 'read', state: 'done', exitCode: 0 }),
    expect.objectContaining({ tool: 'bash', state: 'error', exitCode: 1 }),
  ])
})
