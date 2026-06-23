# Live data layer — wiring contract

The redesign renders desktop **and** mobile from one shared `state` and the
static mock data in `../data.js` / `../mobile/mobile-data.js`. This `live/`
layer swaps that mock for real backend data **per surface**, with mock fallback
so the UI never breaks.

## How it works

- `app.js` calls `loadSurface(name)` (see `index.js`) whenever a surface becomes
  active (boot, nav, breakpoint cross). It dynamically `import()`s `./<name>.js`,
  merges that module's `actions` into the global action map, runs its
  `load(state)`, then re-renders.
- Render functions read `state.live[<surface>]` and **fall back to the mock**
  when it's absent. Example seam already in place:
  `const emails = s.live?.email?.emails ?? EMAILS;`
- So a surface goes live the moment its `live/<surface>.js` exists and populates
  `state.live[<surface>]` in the **same shape as the mock**.

## What each `live/<surface>.js` exports

```js
// NOTE: live/<surface>.js sits IN live/, so import siblings with ./
import { runtime } from './runtime.js';
import { apiGet, apiJson, apiForm } from './api.js';

// Populate state.live.<surface> in the mock's shape. Throwing keeps the mock.
export async function load(state, { force } = {}) {
  const raw = await apiGet('/api/...');
  state.live.<surface> = transformToMockShape(raw);
}

// Optional: action handlers (merged over the mock actions; yours win).
// Mutations should update state, call runtime.render(), then await the API,
// then runtime.render() again (optimistic UI). Re-read live data via load().
export const actions = {
  someAction: async (arg) => { /* ...; runtime.render(); */ },
};
```

`runtime.state` and `runtime.render()` are available for async re-renders.
`api.js` provides `apiGet`, `apiJson(path, body, method)`, `apiForm(path, fields)`,
`apiDelete`, `postStream(path, fields, onEvent)` (chat SSE-over-POST),
`openSSE(path, onEvent)` (EventSource), `wsUrl(path)`.

## Rules for wiring agents

1. **Create ONLY your `live/<surface>.js`.** Do not edit `surfaces.js`,
   `companion.js`, `mobile/*`, `app.js`, or other agents' files. (Exception:
   the **chat** agent may edit `surfaces.js` chat functions.) The render seams
   that read `state.live.*` already exist for every other surface.
2. **Match the mock shape exactly** so the existing render works unchanged. Read
   the mock constant in `../data.js` (or `../mobile/mobile-data.js`) and produce
   the same fields.
3. **Fail soft.** Wrap fetches; on error, throw (the loader keeps the mock) or
   leave `state.live.<surface>` unset. Never break the render.
4. **All endpoints are same-origin** (`location.origin`, `127.0.0.1:8800`), no
   auth header needed. Mind the documented gotchas (FormData vs JSON; response
   envelopes that lack `success`; folder-scoped email UIDs; etc.).
5. **Don't run `scripts/sync-frontend.sh`, restart services, or commit.**
   Syntax-check with `node --input-type=module --check < live/<surface>.js`.
   The parent will build, verify, and commit.
6. Desktop and mobile share `state.live.<surface>`, so wiring once lights up
   both shells.
