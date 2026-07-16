import { create } from 'zustand'

export interface ShellLayoutState {
  railCollapsed: boolean
  railWidth: number
  chatSessionsWidth: number
  chatModelsWidth: number
  workspaceWidth: number
  terminalHeight: number
  taskWidth: number
  toggleRail(): void
  setRailWidth(value: number): void
  setChatSessionsWidth(value: number): void
  setChatModelsWidth(value: number): void
  setWorkspaceWidth(value: number): void
  setTerminalHeight(value: number): void
  setTaskWidth(value: number): void
}

const PREFIX = 'next:layout:'
const readNumber = (key: string, fallback: number) => {
  const value = Number(localStorage.getItem(PREFIX + key))
  return Number.isFinite(value) && value > 0 ? value : fallback
}
const clamp = (value: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, value)))
const setter = (key: string, min: number, max: number, set: (value: Record<string, number>) => void) => (value: number) => {
  const next = clamp(value, min, max)
  localStorage.setItem(PREFIX + key, String(next))
  set({ [key]: next })
}

export const useShellLayout = create<ShellLayoutState>((set) => ({
  railCollapsed: localStorage.getItem(PREFIX + 'railCollapsed') === '1',
  railWidth: readNumber('railWidth', 212),
  chatSessionsWidth: readNumber('chatSessionsWidth', 290),
  chatModelsWidth: readNumber('chatModelsWidth', 260),
  workspaceWidth: readNumber('workspaceWidth', 980),
  terminalHeight: readNumber('terminalHeight', 520),
  taskWidth: readNumber('taskWidth', 760),
  toggleRail: () => set(state => {
    const railCollapsed = !state.railCollapsed
    localStorage.setItem(PREFIX + 'railCollapsed', railCollapsed ? '1' : '0')
    return { railCollapsed }
  }),
  setRailWidth: setter('railWidth', 180, 340, set),
  setChatSessionsWidth: setter('chatSessionsWidth', 240, 440, set),
  setChatModelsWidth: setter('chatModelsWidth', 210, 420, set),
  setWorkspaceWidth: setter('workspaceWidth', 540, 1500, set),
  setTerminalHeight: setter('terminalHeight', 260, 900, set),
  setTaskWidth: setter('taskWidth', 440, 1200, set),
}))
