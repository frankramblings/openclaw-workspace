import {create} from 'zustand'
import {apiDelete,apiGet,apiJson} from '../../api/client'
import {idle,makeLoader,type Remote} from '../../lib/remote'
import type{DocumentFull,DocumentLibrary,Version}from'./types'

interface DocumentsState{
 library:Remote<DocumentLibrary>;document:Remote<DocumentFull>;versions:Remote<Version[]>;selected:string|null;tabs:string[];cache:Record<string,DocumentFull>;saveState:'idle'|'saving'|'saved'|'failed';error:string|null;query:string;sort:'recent'|'alpha';language:string;archived:boolean
 load():Promise<void>;select(id:string):Promise<void>;close(id:string):void;moveTab(id:string,delta:number):void;create(title?:string):Promise<void>;setFilters(values:Partial<Pick<DocumentsState,'query'|'sort'|'language'|'archived'>>):Promise<void>;save(content:string,title:string,language?:string):Promise<void>;archive():Promise<void>;remove():Promise<void>;restore(n:number):Promise<void>
}
const libraryLoader=makeLoader<DocumentLibrary>(),documentLoader=makeLoader<DocumentFull>(),versionsLoader=makeLoader<Version[]>()
const savedTabs=()=>{try{return JSON.parse(localStorage.getItem('next:document-tabs')||'[]') as string[]}catch{return[]}}
const persist=(tabs:string[])=>localStorage.setItem('next:document-tabs',JSON.stringify(tabs))

export const useDocumentsStore=create<DocumentsState>((set,get)=>{
 const load=()=>libraryLoader(()=>apiGet(`/api/documents/library?search=${encodeURIComponent(get().query)}&sort=${get().sort}&language=${encodeURIComponent(get().language)}&archived=${get().archived}`),library=>set({library}),get().library)
 const select=async(id:string)=>{
  const tabs=get().tabs.includes(id)?get().tabs:[...get().tabs,id];persist(tabs);set({selected:id,tabs,saveState:'idle',document:get().cache[id]?{status:'ready',data:get().cache[id],fetchedAt:Date.now()}:get().document})
  await Promise.all([documentLoader(()=>apiGet(`/api/document/${encodeURIComponent(id)}`),document=>{if(document.status==='ready')set(state=>({document,cache:{...state.cache,[id]:document.data}}));else set({document})},get().document),versionsLoader(()=>apiGet(`/api/document/${encodeURIComponent(id)}/versions`),versions=>set({versions}),get().versions)])
 }
 return{library:idle,document:idle,versions:idle,selected:null,tabs:savedTabs(),cache:{},saveState:'idle',error:null,query:'',sort:'recent',language:'',archived:false,load,select,
 close:(id)=>{const previous=get().selected,tabs=get().tabs.filter(tab=>tab!==id);persist(tabs);const selected=previous===id?(tabs.at(-1)||null):previous;set({tabs,selected,...(!selected?{document:idle,versions:idle}:{})});if(selected&&selected!==previous)void select(selected)},
 moveTab:(id,delta)=>{const tabs=[...get().tabs],index=tabs.indexOf(id),next=Math.max(0,Math.min(tabs.length-1,index+delta));if(index<0||index===next)return;tabs.splice(index,1);tabs.splice(next,0,id);persist(tabs);set({tabs})},
 create:async(title='Untitled')=>{set({error:null});try{const doc=await apiJson<DocumentFull>('POST','/api/document',{title,language:'markdown',content:''});set(state=>({cache:{...state.cache,[doc.id]:doc}}));await load();await select(doc.id)}catch(error){set({error:error instanceof Error?error.message:String(error)})}},
 setFilters:async(values)=>{set(values);await load()},
 save:async(content,title,language)=>{const id=get().selected;if(!id)return;set({saveState:'saving',error:null});try{const data=await apiJson<DocumentFull>('PUT',`/api/document/${encodeURIComponent(id)}`,{content,title,...(language?{language}:{})});set(state=>({document:{status:'ready',data,fetchedAt:Date.now()},cache:{...state.cache,[id]:data},saveState:'saved'}));await load()}catch(error){set({saveState:'failed',error:error instanceof Error?error.message:String(error)})}},
 archive:async()=>{const id=get().selected;if(!id)return;const current=get().document,archived=current.status==='ready'?Boolean(current.data.archived):get().archived;set({error:null});try{await apiJson('POST',`/api/document/${encodeURIComponent(id)}/archive?archived=${!archived}`);get().close(id);await load()}catch(error){set({error:error instanceof Error?error.message:String(error)})}},
 remove:async()=>{const id=get().selected;if(!id)return;set({error:null});try{await apiDelete(`/api/document/${encodeURIComponent(id)}`);get().close(id);await load()}catch(error){set({error:error instanceof Error?error.message:String(error)})}},
 restore:async(n)=>{const id=get().selected;if(!id)return;set({error:null});try{const data=await apiJson<DocumentFull>('POST',`/api/document/${encodeURIComponent(id)}/restore/${n}`);set(state=>({document:{status:'ready',data,fetchedAt:Date.now()},cache:{...state.cache,[id]:data},saveState:'saved'}));await select(id)}catch(error){set({error:error instanceof Error?error.message:String(error)})}},
 }
})
