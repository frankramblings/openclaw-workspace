import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { ComposeAttachments, type ComposeAttachment } from './ComposeAttachments'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Harness() {
  const [attachments, setAttachments] = useState<ComposeAttachment[]>([])
  return <ComposeAttachments value={attachments} onChange={setAttachments} />
}

test('uploads files into removable sendable attachment chips', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    files: [{ id: 'stored.txt', name: 'brief.txt', url: '/api/upload/stored.txt' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })))
  const { container } = render(<Harness />)
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File(['hello'], 'brief.txt', { type: 'text/plain' })] } })

  await screen.findByText(/brief\.txt/)
  await vi.waitFor(() => expect(screen.queryByText(/uploading/)).toBeNull())
  expect(fetch).toHaveBeenCalledWith('/api/upload', expect.objectContaining({ method: 'POST' }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove brief.txt' }))
  expect(screen.queryByText(/brief\.txt/)).toBeNull()
})

test('keeps a failed upload visible and non-sendable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
  const { container } = render(<Harness />)
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'bad.txt')] } })
  await screen.findByText(/bad\.txt · failed/)
})
