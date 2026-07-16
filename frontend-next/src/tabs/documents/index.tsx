import { useEffect, useState } from 'react'
import { Button, Card, EmptyState, ListRow, RemoteView, SectionHeader } from '../../kit'
import { Md } from '../chat/Message'
import { useDocumentsStore } from './store'

export function DocumentsTab() {
  const store = useDocumentsStore()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [preview, setPreview] = useState(false)
  useEffect(() => {
    void store.load()
    const id = sessionStorage.getItem('next:document')
    if (id) { sessionStorage.removeItem('next:document'); void store.select(id) }
  }, [])
  useEffect(() => {
    if (store.document.status === 'ready') {
      setTitle(store.document.data.title)
      setBody(store.document.data.current_content)
    }
  }, [store.document])
  return <main className="next-tab"><SectionHeader title="Documents" actions={<Button onClick={() => void store.load()}>Refresh</Button>} />
    <div className="next-grid"><Card title="Library"><RemoteView remote={store.library} onRetry={store.load} empty={<EmptyState title="No documents" />} isEmpty={(data) => data.documents.length === 0}>{(data) => data.documents.map((doc) => <ListRow key={doc.id} title={doc.title || 'Untitled'} meta={`${doc.language} · ${doc.updated_at}`} selected={store.selected === doc.id} onClick={() => void store.select(doc.id)} />)}</RemoteView></Card>
      <Card title="Document"><RemoteView remote={store.document}>{() => <><input aria-label="Document title" value={title} onChange={(e) => setTitle(e.target.value)} />{preview ? <Md src={body} /> : <textarea aria-label="Document content" value={body} onChange={(e) => setBody(e.target.value)} style={{ minHeight: 420 }} />}<p>{store.saveState}</p><Button onClick={() => void store.save(body, title)}>Save</Button><Button variant="ghost" onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</Button>{store.selected && <a className="btn btn-ghost" href={`/api/document/${encodeURIComponent(store.selected)}/export?format=docx`}>Export</a>}<Button variant="ghost" onClick={() => void store.archive()}>Archive</Button><Button variant="danger" onClick={() => void store.remove()}>Delete</Button><RemoteView remote={store.versions}>{(versions) => versions.length ? <div><h4>Versions</h4>{versions.map((version) => <Button key={version.version} variant="ghost" onClick={() => void store.restore(version.version)}>Restore v{version.version}</Button>)}</div> : null}</RemoteView></>}</RemoteView></Card></div>
  </main>
}

