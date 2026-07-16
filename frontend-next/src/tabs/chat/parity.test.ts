import { branchStorageKey, safeDownloadSlug, sliceBranchPrefix } from './parity'
import type { Bubble } from './reducer'

const bubble = (id: string, role: Bubble['role'], text: string): Bubble => ({ id, role, text, thinking: '', cards: [], images: [] })

test('branch prefix includes the selected message and nothing after it', () => {
  const thread = [bubble('u1', 'user', 'one'), bubble('a1', 'assistant', 'two'), bubble('u2', 'user', 'three')]
  expect(sliceBranchPrefix(thread, 'a1')).toEqual([
    { id: 'u1', role: 'user', text: 'one' },
    { id: 'a1', role: 'assistant', text: 'two' },
  ])
  expect(sliceBranchPrefix(thread, 'missing')).toBeNull()
})

test('branch storage and download names are stable and safe', () => {
  expect(branchStorageKey('abc')).toBe('next:branch-prefix:abc')
  expect(safeDownloadSlug('Hello there / friend\nbody')).toBe('Hello_there_friend')
})
