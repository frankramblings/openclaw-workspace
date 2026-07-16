import { create } from 'zustand'

interface TerminalPanelState { open: boolean; sessionKey: string | null; pinned: string[]; show: (key?: string) => void; close: () => void; choose: (key: string) => void; togglePin: (key: string) => void }
const savedPins = () => { try { const value = JSON.parse(localStorage.getItem('next:terminal-pins') || '[]'); return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [] } catch { return [] } }
export const useTerminalPanel = create<TerminalPanelState>((set) => ({
  open: localStorage.getItem('next:terminal-open') === '1', sessionKey: localStorage.getItem('next:terminal-key'), pinned: savedPins(),
  show: (key) => { localStorage.setItem('next:terminal-open', '1'); set((state) => ({ open: true, sessionKey: key || state.sessionKey })) }, close: () => { localStorage.setItem('next:terminal-open', '0'); set({ open: false }) },
  choose: (sessionKey) => { localStorage.setItem('next:terminal-key', sessionKey); set({ sessionKey }) },
  togglePin: (key) => set(state => { const pinned = state.pinned.includes(key) ? state.pinned.filter(item => item !== key) : [...state.pinned, key]; localStorage.setItem('next:terminal-pins', JSON.stringify(pinned)); return { pinned } }),
}))
