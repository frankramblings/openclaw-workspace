import { useTaskPanel } from '../tasks/store'
import { useTerminalPanel } from '../terminal/store'
import { ResizeHandle } from './ResizeHandle'
import { useShellLayout } from './store'

export function CompanionResizeHandles() {
  const terminalOpen = useTerminalPanel(state => state.open)
  const taskOpen = useTaskPanel(state => state.open)
  const layout = useShellLayout()
  return <>
    {terminalOpen && <div className="next-companion-resizer is-terminal"><ResizeHandle axis="y" invert value={layout.terminalHeight} onChange={layout.setTerminalHeight} label="Resize terminal" /></div>}
    {taskOpen && <div className="next-companion-resizer is-task"><ResizeHandle axis="x" invert value={layout.taskWidth} onChange={layout.setTaskWidth} label="Resize task feed" /></div>}
  </>
}
