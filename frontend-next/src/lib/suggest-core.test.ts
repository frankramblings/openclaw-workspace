// Converted from frontend-overrides/js/__tests__/suggest-core.test.js
import { test, expect } from 'vitest'
import { buildSuggestContext, activitySummary, suggestSurvivesReattach } from './suggest-core'
import type { SuggestGhost } from './suggest-core'

test('formats thread as role-labelled lines, most recent last', () => {
  const ctx = buildSuggestContext([
    { role: 'user', text: 'check my cron jobs' },
    { role: 'assistant', text: 'One job is failing.' },
  ])
  expect(ctx).toMatch(/^User: check my cron jobs\n\nAssistant: One job is failing\.$/)
})

test('skips empty/whitespace messages and non-array threads', () => {
  expect(buildSuggestContext([{ role: 'user', text: '  ' }])).toBe('')
  expect(buildSuggestContext(null)).toBe('')
})

test('appends extra activity block after the thread', () => {
  const ctx = buildSuggestContext([{ role: 'user', text: 'hi' }], 'Assistant is still working.')
  expect(ctx).toMatch(/User: hi\n\nAssistant is still working\.$/)
})

test('caps at 4000 chars keeping the tail', () => {
  const long = 'a'.repeat(5000) + 'TAIL'
  const ctx = buildSuggestContext([{ role: 'user', text: long }])
  expect(ctx.length).toBe(4000)
  expect(ctx.endsWith('TAIL')).toBe(true)
})

test('suggestSurvivesReattach: midturn ghost for the re-attached session only', () => {
  const mid: SuggestGhost = { text: 'While you wait…', mode: 'midturn', sessionId: 's1' }
  expect(suggestSurvivesReattach(mid, 's1')).toBe(true)
  expect(suggestSurvivesReattach(mid, 's2')).toBe(false)
  expect(suggestSurvivesReattach({ ...mid, mode: 'followup' }, 's1')).toBe(false)
  expect(suggestSurvivesReattach(null, 's1')).toBe(false)
})

test('activitySummary lists recent step labels, empty when no steps', () => {
  expect(activitySummary(null)).toBe('')
  expect(activitySummary({ steps: [] })).toBe('')
  const s = activitySummary({ steps: [
    { label: 'Ran command', file: 'backend/cron.py' },
    { label: 'Thinking' },
  ] })
  expect(s).toMatch(/still working/i)
  expect(s).toMatch(/- Ran command backend\/cron\.py/)
  expect(s).toMatch(/- Thinking/)
})
