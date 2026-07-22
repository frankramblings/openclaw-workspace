import { test, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ActivityTrail } from './ActivityTrail'
import type { ToolCard } from './reducer'

const done = (over: Partial<ToolCard> = {}): ToolCard => ({
  toolId: over.toolId ?? 't1',
  tool: 'Bash',
  command: 'arr search sonarr "Paddington"',
  output: '[0] Paddington (1976)\n[1] Paddington Bear (1989)',
  exitCode: 0,
  state: 'done',
  ...over,
} as ToolCard)

test('renders the classic act-wrap trail, collapsed when every step is done', () => {
  const { container } = render(<ActivityTrail cards={[done()]} />)
  const wrap = container.querySelector('details.act-wrap')
  expect(wrap).toBeTruthy()
  expect(wrap!.hasAttribute('open')).toBe(false)
  expect(container.querySelector('.act-summary .act-worked')?.textContent).toContain('1 step')
})

test('stays open while a step is running', () => {
  const { container } = render(<ActivityTrail cards={[done({ state: 'running', output: '' })]} />)
  expect(container.querySelector('details.act-wrap')!.hasAttribute('open')).toBe(true)
})

test('steps render as classic act-rows with mono command and act-code output lines', () => {
  const { container } = render(<ActivityTrail cards={[done()]} />)
  expect(container.querySelector('.act-spine')).toBeTruthy()
  expect(container.querySelector('.act-row .file')?.textContent).toContain('arr search sonarr')
  expect(container.querySelectorAll('.act-code .ln').length).toBe(2)
  // The unstyled phase-3 classes must be gone — they had no CSS at all.
  expect(container.querySelector('.act-output')).toBeNull()
  expect(container.querySelector('.act-step')).toBeNull()
})

test('failed steps expose the exit code as row meta', () => {
  const { container } = render(<ActivityTrail cards={[done({ exitCode: 1, state: 'error' })]} />)
  expect(container.querySelector('.act-row .meta')?.textContent).toBe('exit 1')
})

test('renders nothing without cards', () => {
  const { container } = render(<ActivityTrail cards={[]} />)
  expect(container.firstChild).toBeNull()
})
