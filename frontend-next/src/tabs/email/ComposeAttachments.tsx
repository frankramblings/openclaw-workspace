import { useRef, type ChangeEvent } from 'react'
import { Button } from '../../kit'

export interface ComposeAttachment { id: string; name: string; url?: string; status?: 'uploading' | 'failed' }

export function ComposeAttachments({ value, onChange }: { value: ComposeAttachment[]; onChange(value: ComposeAttachment[]): void }) {
  const sequence = useRef(0)
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (!files.length) return
    const placeholders = files.map(file => ({ id: `email-upload-${++sequence.current}`, name: file.name, status: 'uploading' as const }))
    onChange([...value, ...placeholders])
    const form = new FormData()
    files.forEach(file => form.append('files', file))
    try {
      const response = await fetch('/api/upload', { method: 'POST', body: form })
      if (!response.ok) throw new Error(`Upload failed (${response.status})`)
      const body = await response.json() as { files?: ComposeAttachment[] }
      const saved = body.files || []
      onChange([...value, ...placeholders.map((item, index) => saved[index] || { ...item, status: 'failed' as const })])
    } catch {
      onChange([...value, ...placeholders.map(item => ({ ...item, status: 'failed' as const }))])
    }
  }
  return <div className="next-email-compose-attachments">
    <label className="btn btn-ghost">Attach files<input hidden type="file" multiple onChange={upload} /></label>
    {value.map(item => <span key={item.id} className={`next-email-compose-chip${item.status ? ` is-${item.status}` : ''}`}>
      📎 {item.name}{item.status === 'uploading' ? ' · uploading' : item.status === 'failed' ? ' · failed' : ''}
      <Button variant="ghost" aria-label={`Remove ${item.name}`} onClick={() => onChange(value.filter(entry => entry.id !== item.id))}>×</Button>
    </span>)}
  </div>
}
