import { create } from 'zustand'

interface TerminalPanelState { open: boolean; sessionKey: string | null; show: (key?: string) => void; close: () => void; choose: (key: string) => void }
export const useTerminalPanel = create<TerminalPanelState>((set) => ({
  open: false, sessionKey: localStorage.getItem('next:terminal-key'),
  show: (key) => set((state) => ({ open: true, sessionKey: key || state.sessionKey })), close: () => set({ open: false }),
  choose: (sessionKey) => { localStorage.setItem('next:terminal-key', sessionKey); set({ sessionKey }) },
}))
