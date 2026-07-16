import { mondayIndex, monthWindow } from './logic'
test('calendar grid starts Monday and contains the month', () => { const w = monthWindow(new Date(2026, 6, 16)); expect(mondayIndex(w.gridStart)).toBe(0); expect(w.gridStart <= w.first).toBe(true); expect(w.gridEnd >= new Date(2026, 6, 31)).toBe(true) })
test('DST months produce whole week grids', () => { const w = monthWindow(new Date(2025, 10, 2)); expect((w.gridEnd.getTime() - w.gridStart.getTime()) / 86_400_000).toBeGreaterThan(20) })
