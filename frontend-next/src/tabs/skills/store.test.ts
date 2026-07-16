import { beforeEach, expect, test, vi } from 'vitest'
import { idle } from '../../lib/remote'
import { useSkillsStore } from './store'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const capabilities = { add: true, delete_workspace: true, edit_workspace: true, toggle: true, audit: false, publish: false, builtin_edit: false }

beforeEach(() => useSkillsStore.setState({ installed: idle, builtin: idle, detail: idle, audit: idle, capabilities, selected: null, pending: null, error: null }))

test('loads the registry capability contract and opens markdown', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path === '/api/skills') return json({ skills: [{ id: 'one', name: 'one', description: 'Skill', enabled: true, category: 'openclaw-workspace', source: 'openclaw-workspace', tags: [] }], capabilities })
    if (path === '/api/skills/builtin') return json({ skills: [] })
    if (path === '/api/skills/one/markdown') return json({ markdown: '# One' })
    throw new Error(`unexpected request ${path}`)
  }))
  await useSkillsStore.getState().load()
  await useSkillsStore.getState().open('one')
  expect(useSkillsStore.getState()).toMatchObject({ capabilities: { add: true, audit: false }, selected: 'one', detail: { status: 'ready', data: { name: 'one', markdown: '# One', builtin: false } } })
  vi.unstubAllGlobals()
})

test('toggles live status and creates workspace skill payloads', async () => {
  const writes: Array<{ path: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); if (init?.body) writes.push({ path, body: JSON.parse(String(init.body)) })
    if (path === '/api/skills/one/enabled' || path === '/api/skills/add') return json({ ok: true })
    if (path === '/api/skills') return json({ skills: [], capabilities })
    if (path === '/api/skills/builtin') return json({ skills: [] })
    throw new Error(`unexpected request ${path}`)
  }))
  const skill = { id: 'one', name: 'one', description: 'Skill', enabled: true, category: 'openclaw-workspace', source: 'openclaw-workspace', tags: [] }
  expect(await useSkillsStore.getState().toggle(skill)).toBe(true)
  expect(await useSkillsStore.getState().add({ name: 'new-skill', description: 'New', when_to_use: 'Now', procedure: 'First\n2. Second', tags: 'one, two', category: 'general' })).toBe(true)
  expect(writes).toContainEqual({ path: '/api/skills/one/enabled', body: { enabled: false } })
  expect(writes).toContainEqual({ path: '/api/skills/add', body: { name: 'new-skill', description: 'New', category: 'general', when_to_use: 'Now', procedure: ['First', 'Second'], tags: ['one', 'two'], status: 'draft' } })
  vi.unstubAllGlobals()
})

test('saves and deletes writable skill files with visible failures', async () => {
  let fail = false
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (fail) return json({ detail: 'read only' }, 403)
    if (path === '/api/skills/one/markdown' || path === '/api/skills/one') return json(path.endsWith('markdown') ? { markdown: '# Edited' } : { ok: true })
    if (path === '/api/skills') return json({ skills: [], capabilities })
    if (path === '/api/skills/builtin') return json({ skills: [] })
    throw new Error(`unexpected request ${path}`)
  }))
  expect(await useSkillsStore.getState().saveMarkdown('one', '# Edited')).toBe(true)
  expect(await useSkillsStore.getState().remove('one')).toBe(true)
  fail = true
  expect(await useSkillsStore.getState().remove('bundled')).toBe(false)
  expect(useSkillsStore.getState().error).toContain('HTTP 403')
  vi.unstubAllGlobals()
})

test('starts, polls and cancels audit only through explicit contracts', async () => {
  let status = 'running'
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path === '/api/skills/audit-all') return json({ ok: true })
    if (path === '/api/skills/audit-all/status') return json({ status, done: status === 'running' ? 1 : 2, total: 2 })
    if (path === '/api/skills/audit-all/cancel') { status = 'cancelled'; return json({ ok: true }) }
    throw new Error(`unexpected request ${path}`)
  }))
  expect(await useSkillsStore.getState().startAudit(['one', 'two'], true)).toBe(true)
  expect(useSkillsStore.getState().audit).toMatchObject({ status: 'ready', data: { status: 'running', done: 1 } })
  expect(await useSkillsStore.getState().cancelAudit()).toBe(true)
  expect(useSkillsStore.getState().audit).toMatchObject({ status: 'ready', data: { status: 'cancelled' } })
  vi.unstubAllGlobals()
})
