import { beforeEach, expect, test } from 'vitest'

beforeEach(() => localStorage.clear())

test('layout dimensions clamp and persist', async () => {
  const { useShellLayout } = await import('./store')
  useShellLayout.getState().setRailWidth(999)
  useShellLayout.getState().setTerminalHeight(100)
  expect(useShellLayout.getState().railWidth).toBe(340)
  expect(useShellLayout.getState().terminalHeight).toBe(260)
  expect(localStorage.getItem('next:layout:railWidth')).toBe('340')
  expect(localStorage.getItem('next:layout:terminalHeight')).toBe('260')
})

test('rail collapsed preference is durable', async () => {
  const { useShellLayout } = await import('./store')
  const before = useShellLayout.getState().railCollapsed
  useShellLayout.getState().toggleRail()
  expect(useShellLayout.getState().railCollapsed).toBe(!before)
  expect(localStorage.getItem('next:layout:railCollapsed')).toBe(before ? '0' : '1')
})
