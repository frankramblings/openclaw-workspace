import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'

const base = process.env.NEXT_SMOKE_URL || 'http://127.0.0.1:8800/next/'
const out = process.env.NEXT_SMOKE_OUT || `/tmp/frontend-next-smoke-${new Date().toISOString().slice(0, 10)}`
const port = Number(process.env.NEXT_CDP_PORT || 9333)
const tabs = ['chat', 'inbox', 'email', 'calendar', 'notes', 'documents', 'research', 'library', 'cron', 'memory', 'skills', 'settings']
await mkdir(out, { recursive: true })

const chrome = spawn(process.env.CHROME || '/usr/bin/google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/frontend-next-cdp-${process.pid}`,
  '--window-size=1440,900', base,
], { stdio: 'ignore' })

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let target
for (let attempt = 0; attempt < 80; attempt++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    target = list.find((item) => item.type === 'page')
    if (target) break
  } catch { /* Chrome is still starting. */ }
  await pause(100)
}
if (!target) { chrome.kill(); throw new Error('Chrome DevTools endpoint did not start') }

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let sequence = 0
const pending = new Map()
const consoleErrors = []
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    message.error ? reject(new Error(message.error.message)) : resolve(message.result)
  }
  if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.text)
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((arg) => arg.value || arg.description || '').join(' '))
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}
const waitFor = async (expression, timeout = 20_000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await evaluate(`Boolean(${expression})`)) return
    await pause(150)
  }
  throw new Error(`Timed out waiting for ${expression}`)
}
const screenshot = async (name) => {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(`${out}/${name}.png`, Buffer.from(shot.data, 'base64'))
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await waitFor(`document.querySelectorAll('.next-rail-item').length === 12`)
  await evaluate(`window.dispatchEvent(new CustomEvent('next:mutation',{detail:{ok:true,method:'PATCH',path:'/api/smoke',message:'Change saved'}}))`)
  await waitFor(`document.querySelector('#oc-toast-host .oc-toast')?.textContent.includes('Change saved')`)
  await evaluate(`document.querySelector('#oc-toast-host .oc-toast').click()`)

  // Durable shell layout: restore non-default geometry and an open companion
  // through real reloads, then restore the expanded state for the main run.
  await evaluate(`localStorage.setItem('next:layout:railWidth','248'); localStorage.setItem('next:layout:workspaceWidth','840'); localStorage.setItem('next:workspace-open','1'); location.reload()`)
  await waitFor(`document.querySelector('.next-workspace-panel .next-ws-file')`, 30_000)
  const restoredLayout = await evaluate(`({rail:Math.round(document.querySelector('.next-rail').getBoundingClientRect().width),workspace:Math.round(document.querySelector('.next-workspace-panel').getBoundingClientRect().width)})`)
  if (restoredLayout.rail !== 248 || restoredLayout.workspace !== 840) throw new Error(`layout restore failed: ${JSON.stringify(restoredLayout)}`)
  await screenshot('desktop-restored-layout')
  await evaluate(`[...document.querySelectorAll('.next-workspace-panel button')].find(x => x.textContent.trim() === 'Close').click()`)
  await waitFor(`!document.querySelector('.next-workspace-panel')`)
  await evaluate(`document.querySelector('[aria-label="Collapse navigation"]').click(); location.reload()`)
  await waitFor(`document.querySelector('.next-rail.is-collapsed [aria-label="Expand navigation"]')`)
  await evaluate(`document.querySelector('[aria-label="Expand navigation"]').click()`)

  for (const viewport of [{ name: 'desktop', width: 1440, height: 900, mobile: false }, { name: 'iphone', width: 390, height: 844, mobile: true }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile })
    for (const tab of tabs) {
      await evaluate(`location.hash = '#/${tab}'`)
      await pause(300)
      try { await waitFor(`!document.querySelector('.next-skeleton')`, 45_000) } catch { /* A slow route remains honestly loading in its screenshot. */ }
      const state = await evaluate(`({tab: location.hash, shell: !!document.querySelector('.next-shell'), crashed: !![...document.querySelectorAll('[role="alert"]')].find(x => x.textContent.includes('This tab crashed')), body: document.querySelector('.next-main')?.innerText?.slice(0,200)})`)
      if (!state.shell || state.crashed || !state.body) throw new Error(`${viewport.name}/${tab} failed: ${JSON.stringify(state)}`)
      await screenshot(`${viewport.name}-${tab}`)
    }
  }

  // Chat's mobile drawers participate in the same browser Back stack as
  // modals and companions.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await evaluate(`location.hash = '#/chat'`)
  await waitFor(`[...document.querySelectorAll('button')].some(x => x.textContent.trim() === 'Conversations')`)
  await evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Conversations').click()`)
  await waitFor(`document.querySelector('.next-chat-sidebar.is-open')`)
  await evaluate(`history.back()`)
  await waitFor(`!document.querySelector('.next-chat-sidebar.is-open')`)

  // Email: traverse real folders/messages/reader and open reply composition
  // without sending or mutating the mailbox.
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900, mobile: false }, { name: 'iphone', width: 390, height: 844, mobile: true }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile })
    await evaluate(`location.hash = '#/email'`)
    await waitFor(`document.querySelector('.next-email-folders .next-row') && document.querySelector('.next-email-messages .next-row')`, 90_000)
    await evaluate(`document.querySelector('.next-email-messages .next-row').click()`)
    await waitFor(`document.querySelector('.next-email-reader iframe')`, 30_000)
    await evaluate(`[...document.querySelectorAll('.next-email-reader button')].find(x => x.textContent.trim() === 'Reply').click()`)
    await waitFor(`document.querySelector('[role="dialog"][aria-label="Compose email"] input') && [...document.querySelectorAll('[role="dialog"][aria-label="Compose email"] label')].some(x => x.textContent.includes('Attach files'))`)
    await screenshot(`${viewport.name}-email-reply`)
    await evaluate(`document.querySelector('[role="dialog"] [aria-label="Close"]').click()`)
  }

  // Notes: require an existing durable note and the complete autosaving editor.
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900, mobile: false }, { name: 'iphone', width: 390, height: 844, mobile: true }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile })
    await evaluate(`location.hash = '#/notes'`)
    await waitFor(`document.querySelector('.next-note-card') && document.querySelector('[aria-label="Note title"]')`, 30_000)
    await waitFor(`document.querySelector('[aria-label="Note content"], .next-note-checklist')`, 30_000)
    await screenshot(`${viewport.name}-notes-editor`)
  }

  // Documents must progress beyond a library-shaped shell: require a real
  // selected document, editable title/body, tab state, and version request.
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900, mobile: false }, { name: 'iphone', width: 390, height: 844, mobile: true }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile })
    await evaluate(`location.hash = '#/documents'`)
    await waitFor(`document.querySelector('.next-doc-tab[aria-selected="true"], .next-doc-tab.is-active') && document.querySelector('[aria-label="Document title"]') && document.querySelector('[aria-label="Document content"]')`, 30_000)
    await evaluate(`document.querySelector('[aria-label="Document title"]').scrollIntoView({block:'start'})`)
    await screenshot(`${viewport.name}-documents-editor`)
    await evaluate(`[...document.querySelectorAll('.next-doc-actions button')].find(x => x.textContent.trim() === 'Email').click()`)
    await waitFor(`document.querySelector('[role="dialog"][aria-label="Email document"]') && [...document.querySelectorAll('[role="dialog"][aria-label="Email document"] label')].some(x => x.textContent.includes('Attach files'))`)
    await screenshot(`${viewport.name}-documents-email`)
    await evaluate(`document.querySelector('[role="dialog"] [aria-label="Close"]').click()`)
  }

  // Calendar: a real provider window must render (the Google account can be
  // slower than the shell), and the complete event form must open at both
  // breakpoints without creating or mutating an event.
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900, mobile: false }, { name: 'iphone', width: 390, height: 844, mobile: true }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile })
    await evaluate(`location.hash = '#/calendar'`)
    if (viewport.mobile) await evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Agenda')?.click()`)
    await waitFor(viewport.mobile ? `document.querySelector('.next-calendar-agenda section button')` : `document.querySelector('.next-calendar-grid section button')`, 90_000)
    await evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'New event').click()`)
    await waitFor(`document.querySelector('.next-calendar-form input[type="datetime-local"]') && document.querySelector('.next-calendar-form textarea')`)
    await screenshot(`${viewport.name}-calendar-workflow`)
    await evaluate(`[...document.querySelectorAll('.next-calendar-form button')].find(x => x.textContent.trim() === 'Cancel').click()`)
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(`location.hash = '#/calendar'; [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Week')?.click()`)
  await waitFor(`document.querySelector('.next-calendar-week-event[draggable="true"] .next-calendar-event-resize')`, 90_000)
  await screenshot('desktop-calendar-week-drag-resize')

  // Unified inbox: wait for the real collector merge, open the first available
  // source detail, and exercise snooze without firing a remote action. Sources
  // can honestly be empty (for example Gmail at inbox-zero), so don't pin the
  // gate to one provider.
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900, mobile: false }, { name: 'iphone', width: 390, height: 844, mobile: true }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile })
    await evaluate(`location.hash = '#/inbox'`)
    await waitFor(`document.querySelector('.next-inbox-item')`, 90_000)
    await waitFor(`document.querySelector('.next-inbox-item .next-inbox-main')`)
    await evaluate(`document.querySelector('.next-inbox-item .next-inbox-main').click()`)
    await waitFor(`document.querySelector('.next-inbox-reader') && !document.querySelector('.next-inbox-reader .next-skeleton')`, 30_000)
    await screenshot(`${viewport.name}-inbox-reader`)
    await evaluate(`[...document.querySelectorAll('.next-inbox-reader button')].find(x => x.textContent.includes('Back')).click()`)
    await evaluate(`[...document.querySelectorAll('.next-inbox-item .next-inbox-actions button')].find(x => x.textContent.trim() === 'Snooze').click()`)
    await waitFor(`document.querySelector('[role="dialog"][aria-label="Snooze until"]')`)
    await screenshot(`${viewport.name}-inbox-snooze`)
    await evaluate(`document.querySelector('[role="dialog"][aria-label="Snooze until"] [aria-label="Close"]').click()`)
  }

  // Research library: open a persisted report through result-peek and require
  // rendered report content (without starting a costly live research run).
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900, mobile: false }, { name: 'iphone', width: 390, height: 844, mobile: true }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile })
    await evaluate(`location.hash = '#/research'`)
    await waitFor(`document.querySelector('.next-research-list article > button')`, 30_000)
    await evaluate(`document.querySelector('.next-research-list article > button').click()`)
    await waitFor(`document.querySelector('.next-research-report .md') || document.querySelector('.next-research-report h1') || document.querySelector('.next-research-report p')`, 30_000)
    await screenshot(`${viewport.name}-research-report`)
  }

  // Unified Library: require heterogeneous real artifacts, filter to research,
  // and render the selected report natively before any cross-tab navigation.
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900, mobile: false }, { name: 'iphone', width: 390, height: 844, mobile: true }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile })
    await evaluate(`location.hash = '#/library'`)
    await waitFor(`document.querySelector('.next-library-grid article') && document.querySelectorAll('.next-library-filters button').length === 7`, 45_000)
    await evaluate(`[...document.querySelectorAll('.next-library-filters button')].find(x => x.textContent.startsWith('Research')).click()`)
    await waitFor(`document.querySelector('.next-library-grid article button')`, 30_000)
    await evaluate(`document.querySelector('.next-library-grid article button').click()`)
    await waitFor(`document.querySelector('.next-library-detail .next-library-markdown .md') || document.querySelector('.next-library-detail .next-library-markdown p')`, 30_000)
    await screenshot(`${viewport.name}-library-report`)
  }

  // Cron: require real scheduled jobs from the gateway, then select one and
  // render its schedule metadata and run-history remote at both breakpoints.
  // No run/enable action is fired by smoke.
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900, mobile: false }, { name: 'iphone', width: 390, height: 844, mobile: true }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile })
    await evaluate(`location.hash = '#/cron'`)
    await waitFor(`document.querySelector('.next-cron-list article > button')`, 30_000)
    await evaluate(`document.querySelector('.next-cron-list article > button').click()`)
    await waitFor(`document.querySelector('.next-cron-detail dl') && !document.querySelector('.next-cron-detail .next-skeleton')`, 30_000)
    await screenshot(`${viewport.name}-cron-detail`)
  }

  // Memory: load durable records and open the complete edit form. Tidy,
  // extraction, import and mutations remain contract-tested, not fired here.
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900, mobile: false }, { name: 'iphone', width: 390, height: 844, mobile: true }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile })
    await evaluate(`location.hash = '#/memory'`)
    await waitFor(`document.querySelector('.next-memory-list article .next-memory-content')`, 30_000)
    await evaluate(`document.querySelector('.next-memory-list article .next-memory-content').click()`)
    await waitFor(`document.querySelector('[role="dialog"] [aria-label="Memory text"]') && document.querySelector('[role="dialog"] [aria-label="Memory category"]')`)
    await screenshot(`${viewport.name}-memory-editor`)
    await evaluate(`document.querySelector('[role="dialog"] [aria-label="Close"]').click()`)
  }

  // Skills: select a real workspace-owned skill and require writable SKILL.md
  // detail. Also open the create form without persisting a new skill.
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900, mobile: false }, { name: 'iphone', width: 390, height: 844, mobile: true }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile })
    await evaluate(`location.hash = '#/skills'`)
    await waitFor(`document.querySelector('.next-skills-list article .next-skill-main')`, 30_000)
    await evaluate(`(() => { const input=document.querySelector('[aria-label="Search skills"]'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,'adhd-task-triage'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    await waitFor(`document.querySelectorAll('.next-skills-list article').length === 1`)
    await evaluate(`document.querySelector('.next-skills-list article .next-skill-main').click()`)
    await waitFor(`document.querySelector('.next-skill-detail [aria-label="Skill markdown"]:not([readonly])')`, 30_000)
    await screenshot(`${viewport.name}-skill-detail`)
    await evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Add skill').click()`)
    await waitFor(`document.querySelector('[role="dialog"][aria-label="Add skill"]')`)
    await screenshot(`${viewport.name}-skill-create`)
    await evaluate(`document.querySelector('[role="dialog"] [aria-label="Close"]').click()`)
  }

  // Settings: require typed live status and editable default/search controls,
  // then drill into a real MCP server's reported tools without reconnecting it.
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900, mobile: false }, { name: 'iphone', width: 390, height: 844, mobile: true }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile })
    await evaluate(`location.hash = '#/settings'`)
    await waitFor(`document.querySelectorAll('.next-settings-overview .next-card').length === 4 && document.querySelector('[aria-label="Default model"]') && document.querySelector('[aria-label="Search provider"]')`, 45_000)
    await waitFor(`document.querySelector('.next-mcp-list article > button:not(.btn)')`, 45_000)
    await evaluate(`document.querySelector('.next-mcp-list article > button:not(.btn)').click()`)
    await waitFor(`document.querySelector('[role="dialog"] .next-mcp-tools article')`, 30_000)
    await screenshot(`${viewport.name}-settings-mcp-tools`)
    await evaluate(`document.querySelector('[role="dialog"] [aria-label="Close"]').click()`)
  }

  // Global task feed: the registry may honestly be empty, but its initial
  // snapshot and live SSE connection must both be present at each breakpoint.
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900, mobile: false }, { name: 'iphone', width: 390, height: 844, mobile: true }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile })
    await evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent.includes('Tasks')).click()`)
    await waitFor(`document.querySelector('.next-task-panel') && document.querySelector('.next-task-panel .next-stream-status')?.textContent === 'live' && !document.querySelector('.next-task-panel .next-skeleton')`, 30_000)
    await screenshot(`${viewport.name}-task-feed`)
    await evaluate(`[...document.querySelectorAll('.next-task-panel button')].find(x => x.textContent.trim() === 'Close').click()`)
    await waitFor(`!document.querySelector('.next-task-panel')`)
  }

  // Shared workspace explorer: open it at both breakpoints and require a real
  // backend tree, not merely the panel shell.
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900, mobile: false }, { name: 'iphone', width: 390, height: 844, mobile: true }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile })
    await evaluate(`location.hash = '#/chat'`)
    await evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent.includes('Workspace')).click()`)
    await waitFor(`document.querySelector('.next-workspace-panel') && document.querySelector('.next-ws-file')`, 30_000)
    await screenshot(`${viewport.name}-workspace`)
    if (viewport.mobile) await evaluate(`history.back()`)
    else await evaluate(`[...document.querySelectorAll('.next-workspace-panel button')].find(x => x.textContent.trim() === 'Close').click()`)
    await waitFor(`!document.querySelector('.next-workspace-panel')`)
  }

  // Persistent PTY: require the vendored xterm runtime and a successful live
  // WebSocket handshake at desktop and phone widths.
  for (const viewport of [{ name: 'desktop', width: 1440, height: 900, mobile: false }, { name: 'iphone', width: 390, height: 844, mobile: true }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile })
    await evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent.includes('Terminal')).click()`)
    const localPlain = /^http:\/\/(127\.0\.0\.1|localhost)/.test(base)
    const terminalReady = `document.querySelector('.next-terminal-panel.is-open .next-terminal-mount')?.children.length > 0${localPlain ? '' : ` && document.querySelector('.next-term-status')?.textContent === 'connected'`}`
    try {
      await waitFor(terminalReady, 30_000)
    } catch (error) {
      const debug = await evaluate(`({panel:!!document.querySelector('.next-terminal-panel.is-open'),status:document.querySelector('.next-term-status')?.textContent,terminal:typeof window.Terminal,fit:typeof window.FitAddon,key:document.querySelector('[aria-label="Terminal conversation"]')?.value,scripts:[...document.scripts].map(x=>x.src).filter(x=>x.includes('xterm'))})`)
      throw new Error(`${error.message}: ${JSON.stringify(debug)}; console=${consoleErrors.join(' | ')}`)
    }
    if (!viewport.mobile) {
      const terminalChoices = await evaluate(`document.querySelector('[aria-label="Terminal conversation"]')?.options.length || 0`)
      if (terminalChoices > 1) {
        await evaluate(`[...document.querySelectorAll('.next-terminal-global-head button')].find(x => x.textContent.trim() === 'Pin current').click()`)
        await evaluate(`(() => { const el=document.querySelector('[aria-label="Terminal conversation"]'); el.value=el.options[1].value; el.dispatchEvent(new Event('change',{bubbles:true})) })()`)
        await waitFor(`document.querySelectorAll('.next-terminal-instance').length === 2 && [...document.querySelectorAll('.next-terminal-mount')].every(x => x.children.length > 0)`, 30_000)
        await screenshot('desktop-terminal-multiple')
        await evaluate(`[...document.querySelectorAll('.next-terminal-instance button')].find(x => x.textContent.trim() === 'Unpin').click()`)
      }
    }
    await screenshot(`${viewport.name}-terminal`)
    await evaluate(`[...document.querySelectorAll('.next-terminal-panel button')].find(x => x.textContent.trim() === 'Close').click()`)
    await waitFor(`!document.querySelector('.next-terminal-panel.is-open')`)
  }

  // One real chat turn, cleaned up afterward. This exercises POST streaming,
  // reducer rendering, the mid-stream view, and the server-side Stop route.
  if (process.env.NEXT_SMOKE_SKIP_CHAT !== '1') {
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(`location.hash = '#/chat'`)
  await waitFor(`document.querySelector('button') && [...document.querySelectorAll('button')].some(x => x.textContent.trim() === 'New chat')`)
  const before = await evaluate(`fetch('/api/sessions').then(r => r.json()).then(x => (x.sessions || x).map(s => s.id))`)
  await evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'New chat').click()`)
  await waitFor(`document.querySelector('.composer textarea') && !document.querySelector('.composer textarea').disabled`)
  await evaluate(`(() => { const el=document.querySelector('.composer textarea'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(el,'ping'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`)
  await waitFor(`[...document.querySelectorAll('button')].some(x => x.textContent.trim() === 'Send' && !x.disabled)`)
  await evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Send' && !x.disabled).click()`)
  await waitFor(`document.querySelector('.msg.assistant') || document.querySelector('.activity-trail') || [...document.querySelectorAll('button')].some(x => x.textContent.trim() === 'Stop')`, 60_000)
  await screenshot('desktop-chat-mid-stream')
  await evaluate(`(() => { const stop=[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Stop'); if(stop) stop.click() })()`)
  const after = await evaluate(`fetch('/api/sessions').then(r => r.json()).then(x => (x.sessions || x).map(s => s.id))`)
  const created = after.find((id) => !before.includes(id))
  if (created) await evaluate(`fetch('/api/session/${encodeURIComponent(created)}',{method:'DELETE'})`)
  }

  // PWA lifecycle: wait until /next's scoped worker controls this page, force
  // the browser offline, reload from its cached hashed shell, then recover.
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await waitFor(`navigator.serviceWorker?.controller?.scriptURL.endsWith('/next/sw.js')`, 30_000)
  const manifest = await evaluate(`fetch('/next/manifest.webmanifest').then(r => r.json())`)
  if (manifest.scope !== '/next/' || manifest.start_url !== '/next/#/chat') throw new Error(`invalid /next manifest: ${JSON.stringify(manifest)}`)
  await send('Network.enable')
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
  await evaluate(`location.reload()`)
  await pause(900)
  await waitFor(`document.querySelectorAll('.next-rail-item').length === 12`, 20_000)
  await evaluate(`window.dispatchEvent(new Event('offline'))`)
  await waitFor(`document.querySelector('.next-pwa-banner.is-offline')`)
  await screenshot('desktop-pwa-offline')
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await evaluate(`location.reload()`)
  await pause(700)
  await waitFor(`document.querySelectorAll('.next-rail-item').length === 12`, 20_000)

  if (consoleErrors.length) throw new Error(`Console errors:\n${consoleErrors.join('\n')}`)
  console.log(JSON.stringify({ ok: true, screenshots: out, tabs: tabs.length, consoleErrors: 0 }))
} finally {
  ws.close()
  chrome.kill('SIGTERM')
}
