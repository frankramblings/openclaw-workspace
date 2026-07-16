import { create } from 'zustand'
import { apiDelete, apiGet, apiJson } from '../../api/client'
import { idle, makeLoader, type Remote } from '../../lib/remote'
import type { EmailList, EmailRead, Folders, Mailbox, ScheduledEmail, Urgency } from './types'

interface EmailState {
  accounts: Remote<Mailbox[]>; folders: Remote<Folders>; messages: Remote<EmailList>; reader: Remote<EmailRead>; urgency: Remote<Urgency>; scheduled: Remote<ScheduledEmail[]>
  folder: string; filter: 'all'|'unread'; offset: number; selectedUid: string | null; ai: Remote<string>; pending: string | null; error: string | null
  load(): Promise<void>; chooseFolder(folder: string): Promise<void>; read(uid: string): Promise<void>; search(q: string): Promise<void>
  mutate(uid: string, action: 'mark-read' | 'mark-unread' | 'archive' | 'delete'): Promise<void>
  send(payload: Record<string, string>, draft?: boolean): Promise<void>; summarize(): Promise<void>; aiReply(): Promise<void>; cancelScheduled(id: string): Promise<void>
  setFilter(filter:'all'|'unread'):Promise<void>; page(delta:number):Promise<void>; move(uid:string,dest:string):Promise<void>; rsvp(uid:string,status:'accepted'|'tentative'|'declined'):Promise<void>
}
const foldersLoader = makeLoader<Folders>(), messagesLoader = makeLoader<EmailList>(), readerLoader = makeLoader<EmailRead>()

export const useEmailStore = create<EmailState>((set, get) => {
  const loadMessages = async (path?: string) => messagesLoader(() => apiGet(path ?? `/api/email/list?folder=${encodeURIComponent(get().folder)}&filter=${get().filter}&limit=50&offset=${get().offset}`), (messages) => set({ messages }), get().messages)
  return {
    accounts: idle, folders: idle, messages: idle, reader: idle, urgency: idle, scheduled: idle, folder: 'INBOX', filter:'all', offset:0, selectedUid: null, ai: idle, pending: null,error:null,
    load: async () => {
      set({ accounts: { status: 'loading' }, urgency: { status: 'loading' }, scheduled: { status: 'loading' } })
      await Promise.all([
        apiGet<Mailbox[]>('/api/email/accounts').then((data) => set({ accounts: { status: 'ready', data, fetchedAt: Date.now() } })).catch((e: Error) => set({ accounts: { status: 'error', error: e.message } })),
        foldersLoader(() => apiGet('/api/email/folders'), (folders) => set({ folders }), get().folders),
        loadMessages(),
        apiGet<Urgency>('/api/email/urgency-state').then((data) => set({ urgency: { status: 'ready', data, fetchedAt: Date.now() } })).catch((e: Error) => set({ urgency: { status: 'error', error: e.message } })),
        apiGet<ScheduledEmail[]>('/api/email/scheduled').then((data) => set({ scheduled: { status: 'ready', data, fetchedAt: Date.now() } })).catch((e: Error) => set({ scheduled: { status: 'error', error: e.message } })),
      ])
    },
    chooseFolder: async (folder) => { set({ folder, offset:0, selectedUid: null, reader: idle }); await loadMessages() },
    read: async (uid) => { set({ selectedUid: uid, ai: idle }); await readerLoader(() => apiGet(`/api/email/read/${encodeURIComponent(uid)}?folder=${encodeURIComponent(get().folder)}`), (reader) => set({ reader }), get().reader); await loadMessages() },
    search: async (q) => { await loadMessages(q.trim() ? `/api/email/search?folder=${encodeURIComponent(get().folder)}&q=${encodeURIComponent(q)}` : undefined) },
    mutate: async (uid, action) => {
      set({ pending: uid,error:null })
      try {
        const suffix = `/${encodeURIComponent(uid)}?folder=${encodeURIComponent(get().folder)}`
        const response = action === 'delete' ? await apiDelete<{ ok: boolean }>(`/api/email/delete${suffix}`) : await apiJson<{ ok: boolean }>('POST', `/api/email/${action}${suffix}`)
        if (!response.ok) throw new Error(`${action} failed`)
        set({ selectedUid: null, reader: idle }); await loadMessages()
      } catch(e){set({error:e instanceof Error?e.message:String(e)})} finally { set({ pending: null }) }
    },
    send: async (payload, draft = false) => {
      set({ pending: draft ? 'draft' : 'send',error:null })
      try {
        const result = await apiJson<Record<string, unknown>>('POST', draft ? '/api/email/draft' : '/api/email/send', payload)
        if (result.error || result.success === false) throw new Error(String(result.error ?? 'Email operation failed'))
        await loadMessages()
      } catch(e){set({error:e instanceof Error?e.message:String(e)});throw e} finally { set({ pending: null }) }
    },
    summarize: async () => {
      const reader = get().reader
      if (reader.status !== 'ready') return
      const mail = reader.data
      set({ ai: { status: 'loading' } })
      try { const result = await apiJson<{ success: boolean; summary?: string; error?: string }>('POST', '/api/email/summarize', { subject: mail.subject, from: mail.from_address, body: mail.body_html }); if (!result.success) throw new Error(result.error); set({ ai: { status: 'ready', data: result.summary ?? '', fetchedAt: Date.now() } }) } catch (e) { set({ ai: { status: 'error', error: e instanceof Error ? e.message : String(e) } }) }
    },
    aiReply: async () => {
      const reader = get().reader
      if (reader.status !== 'ready') return
      const mail = reader.data
      set({ ai: { status: 'loading' } })
      try { const result = await apiJson<{ reply: string }>('POST', '/api/email/ai-reply', { subject: mail.subject, from_address: mail.from_address, original_body: mail.body_html }); set({ ai: { status: 'ready', data: result.reply, fetchedAt: Date.now() } }) } catch (e) { set({ ai: { status: 'error', error: e instanceof Error ? e.message : String(e) } }) }
    },
    cancelScheduled: async (id) => { const result = await apiDelete<{ ok: boolean }>(`/api/email/scheduled/${encodeURIComponent(id)}`); if (!result.ok) throw new Error('Cancel failed'); await get().load() },
    setFilter:async(filter)=>{set({filter,offset:0});await loadMessages()},
    page:async(delta)=>{set({offset:Math.max(0,get().offset+delta*50),selectedUid:null,reader:idle});await loadMessages()},
    move:async(uid,dest)=>{set({pending:uid,error:null});try{const result=await apiJson<{ok:boolean}>('POST',`/api/email/move/${encodeURIComponent(uid)}?folder=${encodeURIComponent(get().folder)}&dest=${encodeURIComponent(dest)}`);if(!result.ok)throw new Error('Move failed');set({selectedUid:null,reader:idle});await loadMessages()}catch(e){set({error:e instanceof Error?e.message:String(e)})}finally{set({pending:null})}},
    rsvp:async(uid,status)=>{set({pending:uid,error:null});try{const result=await apiJson<{ok:boolean;error?:string}>('POST',`/api/email/rsvp/${encodeURIComponent(uid)}`,{rsvp:status,folder:get().folder});if(!result.ok)throw new Error(result.error||'RSVP failed');set({selectedUid:null,reader:idle});await loadMessages()}catch(e){set({error:e instanceof Error?e.message:String(e)})}finally{set({pending:null})}},
  }
})
