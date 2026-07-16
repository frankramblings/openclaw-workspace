import { create } from 'zustand'

interface TerminalPanelState { open: boolean; sessionKey: string | null; show: (key?: string) => void; close: () => void; choose: (key: string) => void }
export const useTerminalPanel = create<TerminalPanelState>((set) => ({
  open: localStorage.getItem('next:terminal-open') === '1', sessionKey: localStorage.getItem('next:terminal-key'),
  show: (key) => { localStorage.setItem('next:terminal-open', '1'); set((state) => ({ open: true, sessionKey: key || state.sessionKey })) }, close: () => { localStorage.setItem('next:terminal-open', '0'); set({ open: false }) },
  choose: (sessionKey) => { localStorage.setItem('next:terminal-key', sessionKey); set({ sessionKey }) },
}))
