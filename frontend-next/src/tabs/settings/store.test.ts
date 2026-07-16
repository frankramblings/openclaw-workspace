import { beforeEach, expect, test, vi } from 'vitest'
import { idle } from '../../lib/remote'
import { useSettingsStore } from './store'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const fixtures: Record<string, unknown> = {
  '/api/config': { agent_name: 'Gary' },
  '/api/capabilities': { chat: { available: true } },
  '/api/gateway/status': { state: 'ok', sessionCount: 2 },
  '/api/doctor': { ok: true, checks: [{ id: 'gateway', ok: true }] },
  '/api/auth/settings': { search_provider: 'serpapi', search_result_count: 5 },
  '/api/default-chat': { endpoint_id: 'openai', model: 'gpt-5.5' },
  '/api/email/config': { enabled: true, provider: 'himalaya' },
  '/api/calendar/config': { enabled: true, provider: 'google' },
  '/api/mcp/servers': { servers: [{ id: 'docs', name: 'Docs', status: 'ok', is_enabled: true, needs_oauth: false, tool_count: 1 }] },
  '/api/models': { items: [{ endpoint_id: 'openai', endpoint_name: 'OpenAI', models: ['gpt-5.5'] }] },
}

beforeEach(() => useSettingsStore.setState({ settings: idle, tools: idle, selectedServer: null, pending: null, error: null, result: null }))

test('loads typed health, connection, model and MCP status', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => json(fixtures[String(input)])))
  await useSettingsStore.getState().load()
  expect(useSettingsStore.getState().settings).toMatchObject({ status: 'ready', data: { config: { agent_name: 'Gary' }, gateway: { state: 'ok' }, defaultChat: { model: 'gpt-5.5' }, mcp: [{ id: 'docs' }], models: [{ endpoint_id: 'openai' }] } })
  vi.unstubAllGlobals()
})

test('persists typed default and search forms then reports search probe result', async () => {
  const writes: Array<{ path: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); if (init?.body) writes.push({ path, body: JSON.parse(String(init.body)) })
    if (path === '/api/default-chat') return init?.method === 'POST' ? json({ ok: true }) : json(fixtures[path])
    if (path === '/api/auth/settings') return init?.method === 'POST' ? json({ ok: true }) : json(fixtures[path])
    if (path === '/api/search/test') return json({ ok: true, count: 3, provider: 'serpapi' })
    return json(fixtures[path])
  }))
  await useSettingsStore.getState().saveDefault('gpt-5.5', 'openai')
  await useSettingsStore.getState().saveSearch({ search_provider: 'serpapi', search_result_count: 7, search_fallback_chain: ['duckduckgo'] })
  expect(await useSettingsStore.getState().testSearch()).toBe(true)
  expect(writes).toContainEqual({ path: '/api/default-chat', body: { model: 'gpt-5.5', endpoint_id: 'openai' } })
  expect(writes).toContainEqual({ path: '/api/auth/settings', body: { search_provider: 'serpapi', search_result_count: 7, search_fallback_chain: ['duckduckgo'] } })
  expect(useSettingsStore.getState().result?.message).toContain('3 results')
  vi.unstubAllGlobals()
})

test('loads MCP tools and re-probes one server', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path === '/api/mcp/servers/docs/tools') return json({ tools: [{ name: 'read_doc', description: 'Read a doc' }] })
    if (path === '/api/mcp/servers/docs/reconnect') return json({ ok: true })
    return json(fixtures[path])
  }))
  await useSettingsStore.getState().openTools('docs')
  expect(useSettingsStore.getState()).toMatchObject({ selectedServer: 'docs', tools: { status: 'ready', data: [{ name: 'read_doc' }] } })
  expect(await useSettingsStore.getState().reconnect('docs')).toBe(true)
  vi.unstubAllGlobals()
})

test('keeps failed action details visible', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ detail: 'provider unavailable' }, 502)))
  expect(await useSettingsStore.getState().testSearch()).toBe(false)
  expect(useSettingsStore.getState()).toMatchObject({ error: expect.stringContaining('HTTP 502'), result: { kind: 'error' } })
  vi.unstubAllGlobals()
})
