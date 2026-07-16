import { create } from 'zustand'
import { apiDelete, apiGet, apiJson } from '../../api/client'
import { idle, makeLoader, type Remote } from '../../lib/remote'
import type { AuditStatus, BuiltinSkill, Skill, SkillCapabilities, SkillDetail } from './types'

interface SkillsState {
  installed: Remote<Skill[]>
  builtin: Remote<BuiltinSkill[]>
  detail: Remote<SkillDetail>
  audit: Remote<AuditStatus>
  capabilities: SkillCapabilities
  selected: string | null
  pending: string | null
  error: string | null
  load(): Promise<void>
  open(name: string, builtin?: boolean): Promise<void>
  close(): void
  toggle(skill: Skill): Promise<boolean>
  setStatus(skill: Skill, status: 'published' | 'draft'): Promise<boolean>
  saveMarkdown(name: string, markdown: string): Promise<boolean>
  saveBuiltin(name: string, text: string): Promise<boolean>
  revertBuiltin(name: string): Promise<boolean>
  add(fields: { name: string; description: string; when_to_use: string; procedure: string; tags: string; category: string }): Promise<boolean>
  remove(name: string): Promise<boolean>
  startAudit(names: string[], skipAudited: boolean): Promise<boolean>
  loadAudit(): Promise<void>
  watchAudit(): () => void
  cancelAudit(): Promise<boolean>
}

const installedLoader = makeLoader<Skill[]>(), builtinLoader = makeLoader<BuiltinSkill[]>(), detailLoader = makeLoader<SkillDetail>(), auditLoader = makeLoader<AuditStatus>()
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export const useSkillsStore = create<SkillsState>((set, get) => {
  const load = async () => Promise.all([
    installedLoader(async () => { const value = await apiGet<{ skills: Skill[]; capabilities?: Partial<SkillCapabilities>; error?: string }>('/api/skills'); if (value.error) throw new Error(value.error); if (value.capabilities) set(state => ({ capabilities: { ...state.capabilities, ...value.capabilities } })); return value.skills }, installed => set({ installed }), get().installed),
    builtinLoader(async () => (await apiGet<{ skills: BuiltinSkill[] }>('/api/skills/builtin')).skills || [], builtin => set({ builtin }), get().builtin),
  ]).then(() => undefined)
  const mutate = async (key: string, action: () => Promise<unknown>, reopen?: () => Promise<void>) => {
    set({ pending: key, error: null })
    try { await action(); await load(); if (reopen) await reopen(); return true } catch (error) { set({ error: message(error) }); return false } finally { set({ pending: null }) }
  }
  const loadAudit = () => auditLoader(() => apiGet<AuditStatus>('/api/skills/audit-all/status'), audit => set({ audit }), get().audit)
  return {
    installed: idle, builtin: idle, detail: idle, audit: idle, capabilities: { add: false, delete_workspace: false, edit_workspace: false, toggle: true, audit: false, publish: false, builtin_edit: false }, selected: null, pending: null, error: null,
    load,
    open: async (name, builtin = false) => { set({ selected: `${builtin ? 'builtin:' : ''}${name}` }); await detailLoader(async () => builtin ? apiGet<{ text?: string; default?: string }>(`/api/skills/builtin/${encodeURIComponent(name)}`).then(value => ({ name, markdown: value.text || '', builtin: true, defaultText: value.default })) : apiGet<{ markdown?: string }>(`/api/skills/${encodeURIComponent(name)}/markdown`).then(value => ({ name, markdown: value.markdown || '', builtin: false })), detail => set({ detail }), get().detail) },
    close: () => set({ selected: null, detail: idle }),
    toggle: skill => mutate(skill.name, async () => { const value = await apiJson<{ ok: boolean }>('POST', `/api/skills/${encodeURIComponent(skill.name)}/enabled`, { enabled: !skill.enabled }); if (!value.ok) throw new Error('Toggle failed') }),
    setStatus: (skill, status) => mutate(skill.name, () => apiJson('PUT', `/api/skills/${encodeURIComponent(skill.name)}`, { status })),
    saveMarkdown: (name, markdown) => mutate(name, () => apiJson('POST', `/api/skills/${encodeURIComponent(name)}/markdown`, { markdown }), () => get().open(name)),
    saveBuiltin: (name, text) => mutate(name, () => apiJson('PUT', `/api/skills/builtin/${encodeURIComponent(name)}`, { text }), () => get().open(name, true)),
    revertBuiltin: name => mutate(name, () => apiDelete(`/api/skills/builtin/${encodeURIComponent(name)}`), () => get().open(name, true)),
    add: fields => mutate('add', () => apiJson('POST', '/api/skills/add', { name: fields.name.trim() || undefined, description: fields.description.trim(), category: fields.category.trim() || 'general', when_to_use: fields.when_to_use.trim(), procedure: fields.procedure.split('\n').map(value => value.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim()).filter(Boolean), tags: fields.tags.split(',').map(value => value.trim()).filter(Boolean), status: 'draft' })),
    remove: name => mutate(name, () => apiDelete(`/api/skills/${encodeURIComponent(name)}`)).then(ok => { if (ok) set({ selected: null, detail: idle }); return ok }),
    startAudit: async (names, skipAudited) => { set({ pending: 'audit', error: null }); try { await apiJson('POST', '/api/skills/audit-all', { scope: 'selected', names, skip_audited: skipAudited }); await loadAudit(); return true } catch (error) { set({ error: message(error) }); return false } finally { set({ pending: null }) } },
    loadAudit,
    watchAudit: () => { void loadAudit(); const timer = window.setInterval(() => { const audit = get().audit; if (audit.status !== 'ready' || audit.data.status === 'running') void loadAudit() }, 1800); return () => window.clearInterval(timer) },
    cancelAudit: async () => { set({ pending: 'cancel-audit', error: null }); try { await apiJson('POST', '/api/skills/audit-all/cancel'); await loadAudit(); return true } catch (error) { set({ error: message(error) }); return false } finally { set({ pending: null }) } },
  }
})
