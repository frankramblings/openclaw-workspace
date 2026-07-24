import { test, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { App } from './App'
import { TABS } from '../tabs/registry'
import { tabFromHash } from './router'

beforeEach(() => {
  window.location.hash = ''
  // Shell mounts fire /api/config + /api/capabilities; answer them harmlessly.
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes('/api/config')) {
      return Response.json({ agent_name: 'TestAgent', accent: '#4fe3d1', workspace_root: '/w', source_url: 'x' })
    }
    if (String(url).includes('/api/email/accounts')) return Response.json([])
    if (String(url).includes('/api/email/folders')) return Response.json({ folders: [] })
    if (String(url).includes('/api/email/list')) return Response.json({ emails: [], total: 0 })
    if (String(url).includes('/api/email/urgency-state')) return Response.json({ per_uid: {} })
    if (String(url).includes('/api/email/scheduled')) return Response.json([])
    if (String(url).includes('/api/memory')) return Response.json({ memory: [] })
    return Response.json({})
  }))
})

test('tabFromHash: parses tab, defaults to chat on empty/unknown shapes', () => {
  expect(tabFromHash('#/inbox')).toBe('inbox')
  expect(tabFromHash('#/settings')).toBe('settings')
  expect(tabFromHash('')).toBe('chat')
  expect(tabFromHash('#garbage')).toBe('chat')
})

test('top bar renders all 12 tabs from the registry, labelled or icon-only', async () => {
  await act(async () => { render(<App />) })
  const nav = screen.getByRole('navigation', { name: 'Primary' })
  // The phone More button shares the tab class but is chrome, not a registry tab.
  const buttons = nav.querySelectorAll('.next-topbar-tab:not(.next-topbar-more), .next-topbar-tab-sm')
  expect(buttons.length).toBe(TABS.length)
  expect(TABS.length).toBe(12)
  // Every tab stays reachable by name even when it renders icon-only.
  for (const tab of TABS) expect(screen.getByRole('button', { name: new RegExp(tab.label) })).toBeTruthy()
})

test('agent name comes from /api/config, not a hardcoded string', async () => {
  await act(async () => { render(<App />) })
  // Appears in both the top-bar brand and the chat welcome (classic parity).
  expect((await screen.findAllByText('TestAgent')).length).toBeGreaterThan(0)
})

test('hash change switches the rendered tab; unknown hash falls back to chat', async () => {
  await act(async () => { render(<App />) })
  await act(async () => {
    window.location.hash = '#/email'
    fireEvent(window, new HashChangeEvent('hashchange'))
  })
  expect(screen.getByRole('navigation', { name: 'Primary' }).querySelector('[aria-current="page"]')?.textContent)
    .toContain('Email')
  expect(screen.getByRole('heading', { name: 'Email' })).toBeTruthy()
  await act(async () => {
    window.location.hash = '#/nonsense-tab'
    fireEvent(window, new HashChangeEvent('hashchange'))
  })
  expect(screen.getByRole('navigation', { name: 'Primary' }).querySelector('[aria-current="page"]')?.textContent)
    .toContain('Chat')
})

test('clicking a top bar tab navigates via the hash', async () => {
  await act(async () => { render(<App />) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Memory/ })) })
  expect(window.location.hash).toBe('#/memory')
})
