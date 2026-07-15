import { test, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { RemoteView } from './RemoteView'
import { Modal } from './Modal'
import { ToastHost, useToasts } from './Toast'
import { StubTab } from './states'

test('RemoteView: loading with no stale renders skeleton', () => {
  render(<RemoteView remote={{ status: 'loading' }}>{(d: string[]) => <ul>{d}</ul>}</RemoteView>)
  expect(screen.getByRole('status', { name: 'Loading' })).toBeTruthy()
})

test('RemoteView: error renders alert with retry wired', () => {
  const retry = vi.fn()
  render(
    <RemoteView remote={{ status: 'error', error: 'HTTP 502: down' }} onRetry={retry}>
      {(d: string[]) => <ul>{d}</ul>}
    </RemoteView>,
  )
  expect(screen.getByRole('alert').textContent).toContain('HTTP 502: down')
  fireEvent.click(screen.getByText('Retry'))
  expect(retry).toHaveBeenCalledOnce()
})

test('RemoteView: ready renders children with data; empty array renders empty node', () => {
  const { rerender } = render(
    <RemoteView remote={{ status: 'ready', data: ['a', 'b'], fetchedAt: 1 }} empty={<p>none</p>}>
      {(d) => <ul>{d.map((x) => <li key={x}>{x}</li>)}</ul>}
    </RemoteView>,
  )
  expect(screen.getAllByRole('listitem').length).toBe(2)
  rerender(
    <RemoteView remote={{ status: 'ready', data: [] as string[], fetchedAt: 1 }} empty={<p>none</p>}>
      {(d) => <ul>{d.map((x) => <li key={x}>{x}</li>)}</ul>}
    </RemoteView>,
  )
  expect(screen.getByText('none')).toBeTruthy()
})

test('RemoteView: loading with stale keeps data visible under aria-busy', () => {
  render(
    <RemoteView remote={{ status: 'loading', stale: ['old'] }}>
      {(d) => <ul>{d.map((x) => <li key={x}>{x}</li>)}</ul>}
    </RemoteView>,
  )
  expect(screen.getByText('old')).toBeTruthy()
  expect(document.querySelector('[aria-busy="true"]')).toBeTruthy()
})

test('Modal: Esc closes; focus lands inside on open', () => {
  const onClose = vi.fn()
  render(
    <Modal open onClose={onClose} title="Test modal">
      <button type="button">inner</button>
    </Modal>,
  )
  // First focusable in DOM order is the header close button — what matters is
  // that focus landed INSIDE the dialog.
  expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledOnce()
})

test('Toast: push renders and auto-expires after 5s', () => {
  vi.useFakeTimers()
  try {
    render(<ToastHost />)
    act(() => useToasts.getState().push('saved', 'ok'))
    expect(screen.getByRole('status').textContent).toContain('saved')
    act(() => { vi.advanceTimersByTime(5100) })
    expect(screen.queryByRole('status')).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

test('StubTab links honestly to the classic app', () => {
  render(<StubTab tab="email" />)
  const a = screen.getByRole('link') as HTMLAnchorElement
  expect(a.getAttribute('href')).toBe('/#/email')
  expect(screen.getByText(/Not built in \/next yet/)).toBeTruthy()
})
