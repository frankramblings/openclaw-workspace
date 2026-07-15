// Converted from frontend-overrides/js/__tests__/chat-activity-group.test.js
import { test, expect } from 'vitest'
import { groupSteps, groupLabel, summarize } from './activity-group'
import type { ActivityStep } from './activity-group'

const step = (id: string, kind: string, state: ActivityStep['state'] = 'done'): ActivityStep =>
  ({ id, kind, state, label: kind, lines: [] })

test('consecutive same-kind runs (>=2) group; a lone run stays single', () => {
  const items = groupSteps([
    step('a', 'read'),
    step('b', 'run'), step('c', 'run'), step('d', 'run'),
    step('e', 'read'),
  ])
  expect(items.map((i) => i.type)).toEqual(['single', 'group', 'single'])
  const g = items[1]
  if (g.type !== 'group') throw new Error('expected group')
  expect(g.kind).toBe('run')
  expect(g.steps.length).toBe(3)
  expect(g.id).toBe('g-b') // id from first member
})

test('a running step never groups and breaks the current run', () => {
  const items = groupSteps([
    step('a', 'run'), step('b', 'run'),
    step('c', 'run', 'running'),
  ])
  expect(items.map((i) => i.type)).toEqual(['group', 'single'])
  const s = items[1]
  if (s.type !== 'single') throw new Error('expected single')
  expect(s.step.id).toBe('c')
})

test('thinking steps never group', () => {
  const items = groupSteps([step('a', 'think'), step('b', 'think')])
  expect(items.map((i) => i.type)).toEqual(['single', 'single'])
})

test('all one kind collapses to a single group', () => {
  const items = groupSteps(Array.from({ length: 48 }, (_, i) => step('s' + i, 'run')))
  expect(items.length).toBe(1)
  expect(items[0].type).toBe('group')
  const g = items[0]
  if (g.type !== 'group') throw new Error('expected group')
  expect(g.steps.length).toBe(48)
})

test('groupLabel is plural and kind-specific', () => {
  expect(groupLabel('run', 11)).toBe('Ran 11 commands')
  expect(groupLabel('read', 2)).toBe('Read 2 files')
  expect(groupLabel('grep', 3)).toBe('Searched 3 times')
})

test('summarize counts per kind in first-seen order, excludes thinking, tallies failures', () => {
  const out = summarize([
    step('t', 'think'),
    step('a', 'read'), step('b', 'read'), step('c', 'read'),
    step('d', 'grep'),
    step('e', 'run'), step('f', 'run', 'error'),
  ])
  expect(out.parts).toEqual(['3 files read', '1 search', '2 commands'])
  expect(out.failed).toBe(1)
})
