import { test, expect } from 'vitest'
import { loadInto, makeLoader } from './remote'
import type { Remote } from './remote'

test('loadInto: loading → ready with data and fetchedAt', async () => {
  const states: Remote<string>[] = []
  await loadInto(async () => 'hello', (r) => states.push(r))
  expect(states.map((s) => s.status)).toEqual(['loading', 'ready'])
  const ready = states[1]
  if (ready.status !== 'ready') throw new Error('expected ready')
  expect(ready.data).toBe('hello')
  expect(ready.fetchedAt).toBeGreaterThan(0)
})

test('loadInto: loading → error with message on reject', async () => {
  const states: Remote<string>[] = []
  await loadInto(async () => { throw new Error('boom') }, (r) => states.push(r))
  expect(states.map((s) => s.status)).toEqual(['loading', 'error'])
  const err = states[1]
  if (err.status !== 'error') throw new Error('expected error')
  expect(err.error).toBe('boom')
  expect(err.stale).toBeUndefined()
})

test('loadInto: previous ready data rides along as stale during refresh and on error', async () => {
  const prev: Remote<string> = { status: 'ready', data: 'old', fetchedAt: 1 }
  const states: Remote<string>[] = []
  await loadInto(async () => { throw new Error('down') }, (r) => states.push(r), prev)
  const loading = states[0]
  if (loading.status !== 'loading') throw new Error('expected loading')
  expect(loading.stale).toBe('old')
  const err = states[1]
  if (err.status !== 'error') throw new Error('expected error')
  expect(err.stale).toBe('old')
})

test('loadInto: stale survives chained refreshes through loading/error states', async () => {
  let current: Remote<number> = { status: 'ready', data: 42, fetchedAt: 1 }
  await loadInto(async () => { throw new Error('x') }, (r) => { current = r }, current)
  await loadInto(async () => 7, (r) => { current = r }, current)
  if (current.status !== 'ready') throw new Error('expected ready')
  expect(current.data).toBe(7)
})

test('makeLoader: a superseded load cannot clobber the newer result (slow success loses)', async () => {
  const load = makeLoader<string>()
  const box: { current: Remote<string> } = { current: { status: 'idle' } }
  const set = (r: Remote<string>) => { box.current = r }
  let releaseSlow!: () => void
  const slowDone = load(
    () => new Promise<string>((res) => { releaseSlow = () => res('OLD') }),
    set,
  )
  await load(async () => 'NEW', set)
  releaseSlow()
  await slowDone
  const final = box.current
  if (final.status !== 'ready') throw new Error('expected ready')
  expect(final.data).toBe('NEW')
})

test('makeLoader: a superseded load\'s late FAILURE is discarded too', async () => {
  const load = makeLoader<string>()
  const box: { current: Remote<string> } = { current: { status: 'idle' } }
  const set = (r: Remote<string>) => { box.current = r }
  let failSlow!: () => void
  const slowDone = load(
    () => new Promise<string>((_res, rej) => { failSlow = () => rej(new Error('stale failure')) }),
    set,
  )
  await load(async () => 'NEW', set)
  failSlow()
  await slowDone
  const final = box.current
  if (final.status !== 'ready') throw new Error(`expected ready, got ${final.status}`)
  expect(final.data).toBe('NEW')
})
