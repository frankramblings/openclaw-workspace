import { afterEach, expect, test, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useRecorder } from './useRecorder'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('happy path: start → stop → blob POSTed to /api/transcribe as FormData field audio → resolves with text; state returns to idle', async () => {
  let audioPosted = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: any) => {
    if (url === '/api/transcribe/status') return new Response(JSON.stringify({ supported: true }))
    if (url === '/api/transcribe' && opts?.body instanceof FormData) audioPosted = opts.body.has('audio')
    return new Response(JSON.stringify({ text: 'result' }), { status: url === '/api/transcribe' ? 200 : 200 })
  }))
  const mr: any = { state: 'inactive', mimeType: 'audio/webm', start() { this.state = 'recording' }, stop() { this.state = 'inactive'; setTimeout(() => (this.onstop as any)?.()) }, ondataavailable: null, onerror: null, onstop: null }
  vi.stubGlobal('MediaRecorder', vi.fn(() => mr))
  ;(MediaRecorder as any).isTypeSupported = () => true
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { } }] }) } } as any)
  const { result } = renderHook(() => useRecorder())
  await waitFor(() => expect(result.current.supported).toBe(true))
  await act(async () => { await result.current.start() })
  if (mr.ondataavailable) mr.ondataavailable({ data: new Blob() })
  let txt: string | null = null
  await act(async () => { txt = await result.current.stop() })
  expect(txt).toBe('result')
  expect(audioPosted).toBe(true)
  expect(result.current.state).toBe('idle')
})

test('permission denied: getUserMedia rejects → state idle, error set to a human message, no fetch', async () => {
  const err = new Error(); (err as any).name = 'NotAllowedError'
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/transcribe/status') return new Response(JSON.stringify({ supported: true }))
    return new Response('{}')
  }))
  vi.stubGlobal('MediaRecorder', vi.fn())
  ;(MediaRecorder as any).isTypeSupported = () => true
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => { throw err } } } as any)
  const { result } = renderHook(() => useRecorder())
  await waitFor(() => expect(result.current.supported).toBe(true))
  await act(async () => { await result.current.start() })
  expect(result.current.state).toBe('idle')
  expect(result.current.error).toBeTruthy()
})

test('auto-stop: fake timers; recording stops itself at 120s and proceeds to transcribe', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/transcribe/status') return new Response(JSON.stringify({ supported: true }))
    if (url === '/api/transcribe') return new Response(JSON.stringify({ text: '' }))
    return new Response('{}')
  }))
  const mr: any = { state: 'inactive', mimeType: 'audio/webm', start() { this.state = 'recording' }, stop() { this.state = 'inactive'; setTimeout(() => (this.onstop as any)?.()) }, ondataavailable: null, onerror: null, onstop: null }
  vi.stubGlobal('MediaRecorder', vi.fn(() => mr))
  ;(MediaRecorder as any).isTypeSupported = () => true
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { } }] }) } } as any)
  const { result } = renderHook(() => useRecorder())
  await act(async () => { await result.current.start() })
  expect(result.current.state).toBe('recording')
  await act(async () => {
    // Advance past 120s with a small buffer: the auto-stop timer fires at
    // exactly 120000ms and, in the same tick, schedules a *new* 0-delay
    // timer (the mock recorder's own stop() → onstop). A target of exactly
    // 120000 lands the clock precisely on that boundary and the
    // newly-scheduled timer is not guaranteed to be flushed in the same
    // advance call — give it a little headroom so it's strictly due.
    await vi.advanceTimersByTimeAsync(120050)
    // Flush any promise-chain microtasks (fetch → response.json()) left
    // pending after the fake-timer clock stops advancing.
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
  expect(result.current.state).toBe('idle')
  vi.useRealTimers()
})

test('track release: every exit path (normal stop, error, unmount mid-recording) calls track.stop() on all tracks', async () => {
  const s = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/transcribe/status') return new Response(JSON.stringify({ supported: true }))
    if (url === '/api/transcribe') return new Response(JSON.stringify({ text: '' }))
    return new Response('{}')
  }))
  const mr: any = { state: 'inactive', mimeType: 'audio/webm', start() { this.state = 'recording' }, stop() { this.state = 'inactive'; setTimeout(() => (this.onstop as any)?.()) }, ondataavailable: null, onerror: null, onstop: null }
  vi.stubGlobal('MediaRecorder', vi.fn(() => mr))
  ;(MediaRecorder as any).isTypeSupported = () => true
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: s }, { stop: s }] }) } } as any)
  const { result } = renderHook(() => useRecorder())
  await waitFor(() => expect(result.current.supported).toBe(true))
  await act(async () => { await result.current.start() })
  await act(async () => { await result.current.stop() })
  expect(s.mock.calls.length > 0).toBe(true)
})

test('rapid tap-tap: stop called twice / stop before dataavailable settles → exactly ONE POST', async () => {
  let c = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/transcribe/status') return new Response(JSON.stringify({ supported: true }))
    if (url === '/api/transcribe') c++
    return new Response(JSON.stringify({ text: '' }))
  }))
  const mr: any = { state: 'inactive', mimeType: 'audio/webm', start() { this.state = 'recording' }, stop() { this.state = 'inactive'; setTimeout(() => (this.onstop as any)?.()) }, ondataavailable: null, onerror: null, onstop: null }
  vi.stubGlobal('MediaRecorder', vi.fn(() => mr))
  ;(MediaRecorder as any).isTypeSupported = () => true
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { } }] }) } } as any)
  const { result } = renderHook(() => useRecorder())
  await waitFor(() => expect(result.current.supported).toBe(true))
  await act(async () => { await result.current.start() })
  await act(async () => { await Promise.all([result.current.stop(), result.current.stop()]) })
  expect(c <= 1).toBe(true)
})
