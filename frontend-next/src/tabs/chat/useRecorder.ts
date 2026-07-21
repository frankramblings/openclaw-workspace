import { useEffect, useRef, useState } from 'react'

export type RecorderState = 'idle' | 'recording' | 'transcribing'

interface RecorderHookResult {
  state: RecorderState
  error: string | null
  elapsedSeconds: number
  supported: boolean
  start: () => Promise<void>
  stop: () => Promise<string | null>
}

// Module-level cached status check (runs once per mount)
let cachedSupported: boolean | null = null

async function checkSupported(): Promise<boolean> {
  if (cachedSupported !== null) return cachedSupported
  try {
    const response = await fetch('/api/transcribe/status')
    if (!response.ok) return false
    const data = await response.json() as { supported?: boolean }
    cachedSupported = Boolean(data.supported)
    return cachedSupported
  } catch {
    return false
  }
}

export function useRecorder(): RecorderHookResult {
  const [state, setStateRaw] = useState<RecorderState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [supported, setSupported] = useState(false)

  // Mirrors `state` synchronously (React state updates are batched/async, so
  // closures captured before a render commits can observe a stale `state`).
  // Callbacks that fire outside a fresh render — the auto-stop timeout, the
  // MediaRecorder's own onerror/onstop, or two rapid stop() calls in the same
  // tick — must consult this ref, not the closed-over `state`, to avoid
  // acting on stale information (double-POST, stuck 'recording', etc).
  const stateRef = useRef<RecorderState>('idle')
  const setState = (next: RecorderState) => {
    stateRef.current = next
    setStateRaw(next)
  }

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopPromiseRef = useRef<Promise<string | null> | null>(null)

  // Check support once on mount
  useEffect(() => {
    let current = true
    void checkSupported().then((supported) => {
      if (current) setSupported(supported && Boolean(navigator.mediaDevices?.getUserMedia))
    })
    return () => { current = false }
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
      releaseAllTracks()
      if (autoStopTimerRef.current) clearTimeout(autoStopTimerRef.current)
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current)
    }
  }, [])

  function releaseAllTracks() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        track.stop()
      })
      streamRef.current = null
    }
  }

  const start = async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      // Determine supported mime type
      const mimeTypes = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
      let selectedMimeType = 'audio/webm'
      for (const mime of mimeTypes) {
        if (MediaRecorder.isTypeSupported(mime)) {
          selectedMimeType = mime
          break
        }
      }

      const mediaRecorder = new MediaRecorder(stream, { mimeType: selectedMimeType })
      mediaRecorderRef.current = mediaRecorder
      chunksRef.current = []

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onerror = () => {
        // A hard recorder error (e.g. tab suspended it mid-recording) must
        // not leave 'recording' stuck: cancel the pending timers so they
        // don't fire against a dead recorder later, drop any resolveStop
        // registration, release tracks, and go back to idle.
        if (autoStopTimerRef.current) {
          clearTimeout(autoStopTimerRef.current)
          autoStopTimerRef.current = null
        }
        if (elapsedTimerRef.current) {
          clearInterval(elapsedTimerRef.current)
          elapsedTimerRef.current = null
        }
        stopPromiseRef.current = null
        setError('Recording error')
        setState('idle')
        releaseAllTracks()
      }

      mediaRecorder.start()
      setState('recording')
      setElapsedSeconds(0)

      // Start elapsed time counter
      elapsedTimerRef.current = setInterval(() => {
        setElapsedSeconds((s) => s + 1)
      }, 1000)

      // Auto-stop after 120 seconds. Must go through doStop() (not a bare
      // mediaRecorder.stop()) so the transcript flow, timer cleanup, and
      // state transition all still happen — a bare stop() would leave
      // `state` stuck at 'recording' forever since nothing would ever
      // assign onstop or resolve.
      autoStopTimerRef.current = setTimeout(() => {
        void doStop()
      }, 120000)
    } catch (e) {
      if ((e as Error).name === 'NotAllowedError') {
        setError('Microphone permission denied')
      } else {
        setError('Unable to start recording')
      }
      setState('idle')
      releaseAllTracks()
    }
  }

  // The single stop implementation, used by both the public stop() and the
  // internal auto-stop timeout. Re-entrancy guard: if a stop is already in
  // flight (checked via stateRef/stopPromiseRef, NOT the closed-over
  // `state`, since two calls in the same synchronous tick — a rapid
  // tap-tap, or the auto-stop timer racing a manual tap — share the same
  // closure and would otherwise both see the pre-transcribing state) return
  // the existing promise instead of re-registering onstop and calling
  // mediaRecorder.stop() a second time. Without this guard the second
  // call's onstop assignment clobbers the first's, and both scheduled
  // native `stop()` callbacks end up invoking that single remaining
  // handler — i.e. a real double-POST to /api/transcribe.
  const doStop = (): Promise<string | null> => {
    if (stopPromiseRef.current) return stopPromiseRef.current
    if (stateRef.current !== 'recording') return Promise.resolve(null)

    const promise = new Promise<string | null>((resolve) => {
      if (autoStopTimerRef.current) {
        clearTimeout(autoStopTimerRef.current)
        autoStopTimerRef.current = null
      }

      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current)
        elapsedTimerRef.current = null
      }

      setState('transcribing')

      const mediaRecorder = mediaRecorderRef.current
      if (!mediaRecorder) {
        stopPromiseRef.current = null
        resolve(null)
        return
      }

      mediaRecorder.onstop = async () => {
        releaseAllTracks()
        try {
          const blob = new Blob(chunksRef.current)
          chunksRef.current = []

          // Determine file extension based on mime type
          const mimeType = mediaRecorder.mimeType || 'audio/webm'
          const extMap: Record<string, string> = {
            'audio/mp4': 'm4a',
            'audio/mpeg': 'mp3',
            'audio/webm': 'webm',
            'audio/wav': 'wav',
            'audio/flac': 'flac',
          }
          const ext = extMap[mimeType.split(';')[0]] || 'webm'

          const formData = new FormData()
          formData.append('audio', blob, `clip.${ext}`)

          const response = await fetch('/api/transcribe', {
            method: 'POST',
            body: formData,
          })

          if (!response.ok) {
            setError('Transcription failed')
            setState('idle')
            stopPromiseRef.current = null
            resolve(null)
            return
          }

          const data = await response.json() as { text?: string; error?: string }
          const text = data.text || ''
          setState('idle')
          stopPromiseRef.current = null
          resolve(text)
        } catch {
          setError('Transcription error')
          setState('idle')
          stopPromiseRef.current = null
          resolve(null)
        }
      }

      mediaRecorder.stop()
    })

    stopPromiseRef.current = promise
    return promise
  }

  const stop = (): Promise<string | null> => doStop()

  return { state, error, elapsedSeconds, supported, start, stop }
}
