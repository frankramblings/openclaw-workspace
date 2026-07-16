import { expect, test } from 'vitest'
import { useTerminalPanel } from './store'

test('terminal pins and selection persist', () => {
  localStorage.clear()
  useTerminalPanel.setState({ pinned: [], sessionKey: null, open: false })
  useTerminalPanel.getState().choose('session-a')
  useTerminalPanel.getState().togglePin('session-a')
  useTerminalPanel.getState().togglePin('session-b')
  expect(useTerminalPanel.getState().pinned).toEqual(['session-a', 'session-b'])
  expect(localStorage.getItem('next:terminal-key')).toBe('session-a')
  expect(JSON.parse(localStorage.getItem('next:terminal-pins') || '[]')).toEqual(['session-a', 'session-b'])
  useTerminalPanel.getState().togglePin('session-a')
  expect(useTerminalPanel.getState().pinned).toEqual(['session-b'])
})
