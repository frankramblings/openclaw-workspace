import { useRef } from 'react'
import { Button, EmptyState, RemoteView } from '../../kit'
import { useWorkspaceStore, type WorkspaceNode } from './store'
import { useHistoryLayer } from '../useHistoryLayer'

function Node({ node, depth = 0 }: { node: WorkspaceNode; depth?: number }) {
  const store = useWorkspaceStore()
  if (node.type === 'dir') return <details className={`next-ws-dir${store.selectedPath === node.path ? ' is-selected' : ''}`} open={depth < 1}>
    <summary style={{ paddingLeft: depth * 12 }} onClick={() => store.selectPath(node.path, 'dir')}><span>▸</span> {node.name}</summary>
    {(node.children ?? []).map((child) => <Node key={child.path} node={child} depth={depth + 1} />)}
  </details>
  return <button type="button" className={`next-ws-file${store.selectedPath === node.path ? ' is-selected' : ''}`} style={{ paddingLeft: 20 + depth * 12 }} onClick={() => void store.openPath(node.path)}>{node.name}<small>{node.size == null ? '' : `${Math.ceil(node.size / 1024)} KB`}</small></button>
}

function findNode(nodes: WorkspaceNode[], path: string | null): WorkspaceNode | null {
  if (!path) return null
  for (const node of nodes) { if (node.path === path) return node; const child = findNode(node.children ?? [], path); if (child) return child }
  return null
}

export function WorkspacePanel() {
  const store = useWorkspaceStore()
  const close = useHistoryLayer(store.open, store.close)
  const upload = useRef<HTMLInputElement>(null)
  if (!store.open) return null
  const mutable = store.tree.status === 'ready' && store.tree.data.mutable
  const selectedNode = store.tree.status === 'ready' ? findNode(store.tree.data.tree, store.selectedPath) : null
  return <aside className="next-workspace-panel" aria-label="Workspace explorer">
    <header className="next-ws-head"><strong>Workspace</strong><select aria-label="Workspace root" value={store.rootKey} onChange={(event) => void store.setRoot(event.target.value)}>{store.roots.status === 'ready' ? store.roots.data.filter((root) => root.available).map((root) => <option key={root.key} value={root.key}>{root.key}</option>) : <option value={store.rootKey}>{store.rootKey}</option>}</select><Button variant="ghost" onClick={() => void store.load(true)}>Refresh</Button><Button variant="ghost" onClick={close}>Close</Button></header>
    {store.error && <p className="next-error-detail" role="alert">{store.error}</p>}
    <div className="next-ws-tools">
      <Button variant="ghost" disabled={!mutable || Boolean(store.pending)} onClick={() => { const path = prompt('New file path', 'untitled.md')?.trim(); if (path) void store.createPath(path) }}>New file</Button>
      <Button variant="ghost" disabled={!mutable || Boolean(store.pending)} onClick={() => { const path = prompt('New folder path', 'new-folder')?.trim(); if (path) void store.createPath(path, true) }}>New folder</Button>
      <Button variant="ghost" disabled={!mutable || Boolean(store.pending)} onClick={() => upload.current?.click()}>Upload</Button>
      {selectedNode && <><Button variant="ghost" disabled={!mutable || Boolean(store.pending)} onClick={() => { const name = prompt('Rename to', selectedNode.name)?.trim(); if (name) void store.rename(selectedNode.path, name) }}>Rename</Button><Button variant="ghost" disabled={!mutable || Boolean(store.pending)} onClick={() => { const dir = prompt('Move to folder', '')?.trim(); if (dir !== undefined) void store.move(selectedNode.path, dir) }}>Move</Button><Button variant="danger" disabled={!mutable || Boolean(store.pending)} onClick={() => { if (confirm(`Delete ${selectedNode.path}?`)) void store.remove(selectedNode.path) }}>Delete</Button>{selectedNode.type === 'dir' && <a className="btn btn-ghost" href={`/api/workspace/archive?path=${encodeURIComponent(selectedNode.path)}`}>ZIP</a>}</>}
      <input ref={upload} hidden type="file" multiple onChange={(event) => { if (event.target.files) void store.upload(event.target.files); event.target.value = '' }} />
    </div>
    <div className="next-ws-body" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (event.dataTransfer.files.length) void store.upload(event.dataTransfer.files, selectedNode?.type === 'dir' ? selectedNode.path : '') }}><nav className="next-ws-tree"><RemoteView remote={store.tree} onRetry={() => void store.load(true)} empty={<EmptyState title="Workspace is empty" />}>{(tree) => <>{tree.truncated && <p className="next-ws-note">Large tree truncated</p>}{tree.tree.map((node) => <Node key={node.path} node={node} />)}</>}</RemoteView></nav>
      <section className="next-ws-editor"><RemoteView remote={store.file} empty={<EmptyState title="Choose a file" hint="Preview or edit workspace content." />}>{(file) => <><header><strong>{file.path}</strong><div>
        {store.rootKey === 'workspace' && <><Button variant="ghost" onClick={() => { const name = prompt('Rename to', file.path.split('/').at(-1))?.trim(); if (name) void store.rename(file.path, name) }}>Rename</Button><Button variant="ghost" onClick={() => { const dir = prompt('Move to folder', '')?.trim(); if (dir !== undefined) void store.move(file.path, dir) }}>Move</Button><Button variant="danger" onClick={() => { if (confirm(`Delete ${file.path}?`)) void store.remove(file.path) }}>Delete</Button></>}
        <a className="btn btn-ghost" href={`/api/workspace/file?path=${encodeURIComponent(file.path)}&root_key=${encodeURIComponent(store.rootKey)}`} download>Download</a>
      </div></header>{file.kind === 'text' ? <><textarea aria-label="File content" readOnly={!mutable} value={file.content} onChange={(event) => store.updateContent(event.target.value)} /><Button variant="primary" disabled={!file.dirty || Boolean(store.pending)} onClick={() => void store.save()}>Save</Button></> : file.kind === 'image' ? <img src={file.content} alt={file.path} /> : file.kind === 'pdf' ? <iframe title={file.path} src={file.content} /> : <EmptyState title="No inline preview" hint="Download this binary file to open it." />}</>}</RemoteView></section>
    </div>
  </aside>
}
