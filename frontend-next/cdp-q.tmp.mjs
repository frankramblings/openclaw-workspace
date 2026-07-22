import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import WebSocket from 'ws'
const port = 9335
const profile = mkdtempSync('/home/frank/ralph-shots/.cdp-q-')
const chrome = spawn('chromium', ['--headless=new','--no-sandbox',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'--window-size=1440,900','about:blank'], { stdio: 'ignore' })
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
let id=0
const rpc=(ws,method,params={})=>new Promise((res,rej)=>{const m=++id;const on=(raw)=>{const msg=JSON.parse(raw);if(msg.id===m){ws.off('message',on);msg.error?rej(new Error(JSON.stringify(msg.error))):res(msg.result)}};ws.on('message',on);ws.send(JSON.stringify({id:m,method,params}))})
const ev=async(ws,e)=>(await rpc(ws,'Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result?.value
try{
  let page=null
  for(let i=0;i<40&&!page;i++){await sleep(250);try{page=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page')}catch{}}
  const ws=new WebSocket(page.webSocketDebuggerUrl,{maxPayload:64*1024*1024})
  await new Promise((r,j)=>{ws.on('open',r);ws.on('error',j)})
  await rpc(ws,'Page.navigate',{url:'http://localhost:8800/#chat'})
  await sleep(9000)
  console.log(await ev(ws,`JSON.stringify({
    bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    panel: getComputedStyle(document.documentElement).getPropertyValue('--panel').trim(),
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    teal: getComputedStyle(document.documentElement).getPropertyValue('--teal').trim(),
    htmlInline: document.documentElement.getAttribute('style'),
    lsTheme: localStorage.getItem('odysseus-theme')?.slice(0,120) ?? null,
    lsAccent: localStorage.getItem('oc-accent'),
    sheets: [...document.styleSheets].map(s=>s.href?.split('/').pop()??'inline'),
  })`))
}finally{chrome.kill('SIGKILL')}
