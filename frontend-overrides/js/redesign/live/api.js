// Same-origin fetch helpers for the redesign's live data layer.
// The workspace app serves every /api/* route on this origin with no auth
// (token unset in this deployment). See live/README.md for the full contract.

const BASE = location.origin;

async function parse(res) {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

/**
 * Thrown by apiJson on any non-2xx response (including 502/503 gateway-restart
 * blips — see the module banner). `.status` is the HTTP status; `.body` is the
 * parsed response body (JSON when the content-type says so, else raw text) so
 * callers that legitimately branch on a structured error (e.g. change-password
 * reading `.body.detail`) can do so without re-fetching or re-parsing.
 */
export class ApiError extends Error {
  constructor(status, body, path, method) {
    super(`${method || 'GET'} ${path || ''} → ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** GET → parsed JSON (throws on non-2xx). */
export async function apiGet(path, { signal } = {}) {
  const res = await fetch(BASE + path, { credentials: 'same-origin', signal });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return parse(res);
}

/**
 * JSON-body request (POST/PUT/PATCH/DELETE) → parsed JSON.
 * Throws ApiError on any !res.ok — including 502/503, which this helper used
 * to swallow and resolve as if the request had succeeded (a gateway restart
 * is a known recurring event on this box). Every mutation caller assumes
 * throw-on-failure, so silently resolving turned a failed write into a fake
 * success: the UI would drop an optimistic revert, close a compose box on an
 * email that was never sent, or alert "saved" for a change that never
 * happened. Callers must catch this to revert optimistic state and surface
 * the failure — see live/inbox.js and live/email.js for the pattern.
 */
export async function apiJson(path, body, method = 'POST') {
  const res = await fetch(BASE + path, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const parsed = await parse(res);
  if (!res.ok) throw new ApiError(res.status, parsed, path, method);
  return parsed;
}

/** multipart/form-data request (the gateway-proxied mutations want this). */
export async function apiForm(path, fields, { method = 'POST', headers = {} } = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields || {})) if (v != null) fd.append(k, v);
  const res = await fetch(BASE + path, { method, credentials: 'same-origin', headers, body: fd });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return parse(res);
}

/** DELETE convenience. */
export function apiDelete(path) {
  return fetch(BASE + path, { method: 'DELETE', credentials: 'same-origin' }).then(parse);
}

/**
 * Read an SSE-style stream returned over a POST (the chat_stream shape):
 * lines prefixed `data: `, terminated by `data: [DONE]`. Calls onEvent(obj)
 * per JSON line. Returns a controller with .abort().
 */
export function postStream(path, fields, onEvent, { headers = {} } = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields || {})) if (v != null) fd.append(k, v);
  const ctrl = new AbortController();
  (async () => {
    const res = await fetch(BASE + path, { method: 'POST', credentials: 'same-origin', headers, body: fd, signal: ctrl.signal });
    if (!res.ok || !res.body) { onEvent({ type: 'error', status: res.status }); return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { onEvent({ type: 'done' }); return; }
        try { onEvent(JSON.parse(payload)); } catch (_) { /* ignore keepalives */ }
      }
    }
    onEvent({ type: 'done' });
  })().catch((e) => onEvent({ type: 'error', error: String(e) }));
  return ctrl;
}

/** EventSource wrapper for GET SSE endpoints (research progress, etc.). */
export function openSSE(path, onEvent) {
  const es = new EventSource(BASE + path, { withCredentials: true });
  es.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch (_) {} };
  es.onerror = () => { /* caller decides; keep open for retry */ };
  return es;
}

/** WebSocket URL on this origin (ws/wss to match http/https). */
export function wsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}
