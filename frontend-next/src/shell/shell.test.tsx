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
    return Response.json({})
  }))
})

test('tabFromHash: parses tab, defaults to chat on empty/unknown shapes', () => {
  expect(tabFromHash('#/inbox')).toBe('inbox')
  expect(tabFromHash('#/settings')).toBe('settings')
  expect(tabFromHash('')).toBe('chat')
  expect(tabFromHash('#garbage')).toBe('chat')
})

test('rail renders all 12 tabs from the registry', async () => {
  await act(async () => { render(<App />) })
  const nav = screen.getByRole('navigation', { name: 'Primary' })
  const buttons = nav.querySelectorAll('.next-rail-item')
  expect(buttons.length).toBe(TABS.length)
  expect(TABS.length).toBe(12)
})

test('agent name comes from /api/config, not a hardcoded string', async () => {
  await act(async () => { render(<App />) })
  expect(await screen.findByText('TestAgent')).toBeTruthy()
})

test('hash change switches the rendered tab; unknown hash falls back to chat', async () => {
  await act(async () => { render(<App />) })
  await act(async () => {
    window.location.hash = '#/email'
    fireEvent(window, new HashChangeEvent('hashchange'))
  })
  expect(screen.getByRole('navigation', { name: 'Primary' }).querySelector('[aria-current="page"]')?.textContent)
    .toContain('Email')
  // Stubbed tab body links to the classic app for that tab.
  expect((screen.getByRole('link', { name: /open email there/ }) as HTMLAnchorElement).getAttribute('href'))
    .toBe('/#/email')
  await act(async () => {
    window.location.hash = '#/nonsense-tab'
    fireEvent(window, new HashChangeEvent('hashchange'))
  })
  expect(screen.getByRole('navigation', { name: 'Primary' }).querySelector('[aria-current="page"]')?.textContent)
    .toContain('Chat')
})

test('clicking a rail item navigates via the hash', async () => {
  await act(async () => { render(<App />) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Memory/ })) })
  expect(window.location.hash).toBe('#/memory')
})
