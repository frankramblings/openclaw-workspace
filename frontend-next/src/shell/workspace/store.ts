import { create } from 'zustand'
import { apiGet, apiJson } from '../../api/client'
import { idle, makeLoader, type Remote } from '../../lib/remote'

export interface WorkspaceNode { name: string; path: string; type: 'dir' | 'file'; size?: number; children?: WorkspaceNode[] }
export interface WorkspaceTree { root: string; root_key: string; branch: string | null; dirty: boolean; tree: WorkspaceNode[]; truncated: boolean; missing: boolean; mutable: boolean }
export interface WorkspaceRoot { key: string; path: string; available: boolean; mutable: boolean }
interface OpenFile { path: string; content: string; mtime: number; kind: 'text' | 'image' | 'pdf' | 'binary'; dirty: boolean }

interface WorkspaceState {
  open: boolean
  rootKey: string
  roots: Remote<WorkspaceRoot[]>
  tree: Remote<WorkspaceTree>
  file: Remote<OpenFile>
  selectedPath: string | null
  error: string | null
  pending: string | null
  show: () => void
  close: () => void
  load: (fresh?: boolean) => Promise<void>
  setRoot: (key: string) => Promise<void>
  openPath: (path: string, rootKey?: string) => Promise<void>
  selectPath: (path: string, type: WorkspaceNode['type']) => void
  updateContent: (content: string) => void
  save: () => Promise<boolean>
  createPath: (path: string, directory?: boolean) => Promise<boolean>
  rename: (path: string, newName: string) => Promise<boolean>
  move: (path: string, destDir: string) => Promise<boolean>
  remove: (path: string) => Promise<boolean>
  upload: (files: FileList | File[], dir?: string) => Promise<boolean>
}

const treeLoader = makeLoader<WorkspaceTree>()
const rootsLoader = makeLoader<WorkspaceRoot[]>()

function fileKind(path: string): OpenFile['kind'] {
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(path)) return 'image'
  if (/\.pdf$/i.test(path)) return 'pdf'
  if (/\.(md|txt|json|js|mjs|cjs|ts|tsx|jsx|py|css|html?|sh|ya?ml|toml|ini|csv|log|sql|env|rb|go|rs|c|cpp|h|java|kt|swift|vue|svelte|php)$/i.test(path) || !/\.[^/]+$/.test(path)) return 'text'
  return 'binary'
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  open: false, rootKey: localStorage.getItem('next:workspace-root') || 'workspace', roots: idle, tree: idle, file: idle,
  selectedPath: null, error: null, pending: null,
  show: () => { set({ open: true }); void get().load() },
  close: () => set({ open: false }),
  load: async (fresh = false) => {
    await Promise.all([
      rootsLoader(async () => (await apiGet<{ roots: WorkspaceRoot[] }>('/api/workspace/roots')).roots, (roots) => set({ roots }), get().roots),
      treeLoader(() => apiGet<WorkspaceTree>(`/api/workspace/tree?hidden=0&root_key=${encodeURIComponent(get().rootKey)}${fresh ? '&fresh=1' : ''}`), (tree) => set({ tree }), get().tree),
    ])
  },
  setRoot: async (key) => {
    localStorage.setItem('next:workspace-root', key)
    set({ rootKey: key, tree: idle, file: idle, selectedPath: null })
    await get().load(true)
  },
  openPath: async (path, rootKey) => {
    if (rootKey && rootKey !== get().rootKey) await get().setRoot(rootKey)
    set({ open: true, selectedPath: path, error: null, file: { status: 'loading' } })
    const kind = fileKind(path)
    const url = `/api/workspace/file?path=${encodeURIComponent(path)}&root_key=${encodeURIComponent(rootKey || get().rootKey)}`
    if (kind !== 'text') { set({ file: { status: 'ready', data: { path, content: url, mtime: 0, kind, dirty: false }, fetchedAt: Date.now() } }); return }
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
      set({ file: { status: 'ready', data: { path, content: await response.text(), mtime: Number(response.headers.get('x-mtime-ns') || 0), kind, dirty: false }, fetchedAt: Date.now() } })
    } catch (error) { set({ file: { status: 'error', error: error instanceof Error ? error.message : String(error) } }) }
  },
  selectPath: (selectedPath, type) => set({ selectedPath, ...(type === 'dir' ? { file: idle } : {}) }),
  updateContent: (content) => set((state) => state.file.status === 'ready' ? { file: { ...state.file, data: { ...state.file.data, content, dirty: true } } } : {}),
  save: async () => {
    const file = get().file
    if (file.status !== 'ready' || file.data.kind !== 'text' || get().rootKey !== 'workspace') return false
    set({ pending: 'save', error: null })
    try {
      const result = await apiJson<{ ok: boolean; mtime_ns: number }>('PUT', '/api/workspace/file', { path: file.data.path, content: file.data.content, if_mtime_ns: file.data.mtime })
      set({ file: { ...file, data: { ...file.data, dirty: false, mtime: result.mtime_ns } } }); return true
    } catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); return false }
    finally { set({ pending: null }) }
  },
  createPath: async (path, directory = false) => get().rootKey === 'workspace' && mutate(get, set, directory ? '/api/workspace/mkdir' : '/api/workspace/create', { path }),
  rename: async (path, newName) => get().rootKey === 'workspace' && mutate(get, set, '/api/workspace/rename', { path, new_name: newName }),
  move: async (path, destDir) => get().rootKey === 'workspace' && mutate(get, set, '/api/workspace/move', { path, dest_dir: destDir }),
  remove: async (path) => get().rootKey === 'workspace' && mutate(get, set, '/api/workspace/delete', { path }),
  upload: async (files, dir = '') => {
    if (get().rootKey !== 'workspace') return false
    set({ pending: 'upload', error: null }); const form = new FormData(); for (const file of Array.from(files)) form.append('files', file); form.append('dir', dir)
    try { const response = await fetch('/api/workspace/upload', { method: 'POST', body: form }); if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`); await get().load(true); return true }
    catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); return false } finally { set({ pending: null }) }
  },
}))

async function mutate(get: () => WorkspaceState, set: (value: Partial<WorkspaceState>) => void, path: string, body: unknown): Promise<boolean> {
  set({ pending: path, error: null })
  try { await apiJson('POST', path, body); await get().load(true); return true }
  catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); return false } finally { set({ pending: null }) }
}
