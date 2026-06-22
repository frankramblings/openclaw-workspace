/*
 * usage-footer.js — compact per-session context-usage pill in the chat input
 * control row, mounted between the Shell-Access button (#bash-toggle-btn, left
 * cluster) and the thinking/Speed selector (#speed-toggle-btn). Falls back to
 * #hermes-footer if the control row isn't present.
 *
 * Reads GET /api/sessions/<id>/usage (backend contract: see
 * tmp/openclaw-usage-contract.md "Backend response contract") and renders a
 * compact bar: `▓▓▓░░ 24%  ·  48.2k tok  ·  $0.62`, with a click-to-expand
 * panel showing input/output split, tool calls, and the system-prompt token
 * estimate.
 *
 * Pure formatters (formatTokens, formatCost, charsToTokens) and the progress-
 * fill visual are PORTED to vanilla JS from OpenClaw Control UI (MIT,
 * Copyright (c) 2026 OpenClaw Foundation):
 *   - ui/src/ui/format.ts                 (formatTokens, formatCost)
 *   - ui/src/ui/views/usage-metrics.ts    (charsToTokens heuristic)
 *   - ui/src/styles/usage.css             (.context-stacked-bar / fill visual)
 * The usage query-language filter engine (usage-helpers.ts) is intentionally
 * NOT ported — out of scope for this footer widget. Attribution lives in
 * frontend-overrides/THIRD-PARTY.md.
 */
(function () {
  'use strict';

  // ---- Ported pure formatters (vanilla JS, MIT — OpenClaw) ----------------

  // ui/src/ui/format.ts :: formatTokens
  function formatTokens(tokens, fallback) {
    if (fallback === undefined) fallback = '0';
    if (tokens == null || !Number.isFinite(tokens)) return fallback;
    if (tokens < 1000) return String(Math.round(tokens));
    if (tokens < 1000000) {
      const k = tokens / 1000;
      return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
    }
    const m = tokens / 1000000;
    return m < 10 ? `${m.toFixed(1)}M` : `${Math.round(m)}M`;
  }

  // ui/src/ui/format.ts :: formatCost
  function formatCost(cost, fallback) {
    if (fallback === undefined) fallback = '$0.00';
    if (cost == null || !Number.isFinite(cost)) return fallback;
    if (cost === 0) return '$0.00';
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    if (cost < 1) return `$${cost.toFixed(3)}`;
    return `$${cost.toFixed(2)}`;
  }

  // ui/src/ui/views/usage-metrics.ts :: charsToTokens (CHARS_PER_TOKEN = 4)
  function charsToTokens(chars) {
    if (chars == null || !Number.isFinite(chars)) return 0;
    return Math.round(chars / 4);
  }

  function formatPct(pct) {
    if (pct == null || !Number.isFinite(pct)) return '—';
    if (pct >= 99.95) return '100%';
    if (pct >= 10) return `${Math.round(pct)}%`;
    return `${pct.toFixed(1)}%`;
  }

  // Glyph progress bar (the contract's `▓▓▓░░` visual), N=10 honest segments.
  function glyphBar(pct) {
    const n = 10;
    const p = Math.max(0, Math.min(100, pct == null ? 0 : pct));
    const filled = Math.round((p / 100) * n);
    return '▓'.repeat(filled) + '░'.repeat(n - filled);
  }

  // ---- State --------------------------------------------------------------

  const API_BASE = window.location.origin;
  const POLL_MS = 5000;
  let _lastSid = null;          // session id of last successful/attempted fetch
  let _lastData = null;         // last {ok:true} payload (for peek + render)
  let _wasStreaming = false;    // streaming state on the previous tick
  let _inFlight = false;
  let _expanded = false;
  let _els = null;              // cached DOM refs once built

  // ---- Current session id (robust, no chat.js/sessions.js coupling) -------
  // Priority: URL hash (selectSession sets `#<id>`) → lastSessionId in storage
  // → the active sidebar row's data-session-id.
  function currentSessionId() {
    const hash = (window.location.hash || '').replace(/^#/, '').trim();
    if (hash) return hash;
    try {
      const stored = localStorage.getItem('lastSessionId');
      if (stored) return stored;
    } catch (_e) { /* storage blocked */ }
    const active = document.querySelector('.list-item.active-session[data-session-id]');
    if (active) return active.getAttribute('data-session-id');
    return null;
  }

  // ---- Run-state (streaming) detection, DOM-based -------------------------
  // chat.js doesn't expose isStreaming on window; it DOES mark the send button
  // (dataset.mode='streaming') and streaming nodes (.msg.msg-ai.streaming /
  // .agent-thread.streaming). Either signal => a run is active.
  function isStreaming() {
    const btn = document.querySelector('.send-btn');
    if (btn && btn.dataset && btn.dataset.mode === 'streaming') return true;
    return !!document.querySelector('.msg.msg-ai.streaming, .agent-thread.streaming');
  }

  // ---- DOM / styles -------------------------------------------------------

  function injectStyles() {
    if (document.getElementById('usage-footer-style')) return;
    const css = `
/* Inline pill in the chat-input control row. Wrapper anchors the popover. */
#usage-inline-wrap{position:relative;display:none;align-items:center;flex:0 0 auto;}
#usage-inline-wrap.uf-show{display:inline-flex;}
#usage-footer-bar{display:inline-flex;align-items:center;gap:6px;
  padding:3px 9px;font-size:11px;line-height:1;cursor:pointer;white-space:nowrap;
  color:var(--muted,#9aa);border:1px solid var(--border,rgba(255,255,255,.12));
  border-radius:var(--radius-full,99px);
  background:color-mix(in srgb,var(--bg-muted,#222) 55%,transparent);
  font-family:var(--hermes-mono,ui-monospace,SFMono-Regular,Menlo,monospace);
  user-select:none;box-sizing:border-box;transition:border-color .15s ease,background .15s ease;}
#usage-footer-bar:hover{border-color:color-mix(in srgb,var(--accent,#4fe3d1) 50%,var(--border,#444));}
/* progress-fill visual ported from usage.css .context-stacked-bar */
#usage-footer-bar .uf-track{position:relative;flex:0 0 auto;width:42px;height:7px;
  border-radius:var(--radius-full,99px);overflow:hidden;
  border:1px solid var(--border,rgba(255,255,255,.12));
  background:color-mix(in srgb,var(--bg-muted,#222) 82%,transparent);}
#usage-footer-bar .uf-fill{position:absolute;inset:0 auto 0 0;width:0;
  background:var(--accent,#4fe3d1);transition:width .25s ease;}
#usage-footer-bar.uf-warn .uf-fill{background:var(--warn,#e3b34f);}
#usage-footer-bar.uf-crit .uf-fill{background:var(--err,var(--danger,#e35f4f));}
#usage-footer-bar .uf-pct{color:var(--text,#e8e8e8);font-weight:600;}
#usage-footer-bar .uf-sep{opacity:.4;}
#usage-footer-bar .uf-caret{opacity:.55;transition:transform .2s ease;font-size:9px;}
#usage-footer-bar.uf-open .uf-caret{transform:rotate(180deg);}
/* Expanded detail: popover anchored above the pill (control row is horizontal). */
#usage-footer-detail{display:none;position:absolute;bottom:calc(100% + 8px);right:0;
  z-index:60;min-width:230px;box-sizing:border-box;
  padding:9px 11px;font-size:11px;line-height:1.55;border-radius:9px;
  color:var(--muted,#9aa);background:var(--bg,#1e1f22);
  border:1px solid var(--border,rgba(255,255,255,.14));
  box-shadow:0 8px 28px rgba(0,0,0,.34);
  font-family:var(--hermes-mono,ui-monospace,SFMono-Regular,Menlo,monospace);}
#usage-footer-detail.uf-show{display:block;}
#usage-footer-detail::after{content:"";position:absolute;top:100%;right:14px;
  border:6px solid transparent;border-top-color:var(--bg,#1e1f22);}
#usage-footer-detail .uf-row{display:flex;justify-content:space-between;gap:12px;}
#usage-footer-detail .uf-row span:last-child{color:var(--text,#e8e8e8);}
#usage-footer-detail .uf-est{opacity:.7;font-style:italic;}
@media (max-width:560px){#usage-footer-bar .uf-costwrap{display:none;}}
#usage-footer-bar .uf-compact{margin-left:6px;padding:0 6px;border-radius:999px;font-size:10px;line-height:16px;white-space:nowrap;background:color-mix(in srgb, var(--accent,#60a5fa) 16%, transparent);color:var(--accent,#60a5fa);}
#usage-footer-bar .uf-compact--active{animation:uf-compact-pulse 1.2s ease-in-out infinite;}
@keyframes uf-compact-pulse{50%{opacity:.45;}}
@media (prefers-reduced-motion:reduce){#usage-footer-bar .uf-compact--active{animation:none;}}
`;
    const style = document.createElement('style');
    style.id = 'usage-footer-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Resolve the mount point: the chat-input control row, right before the
  // thinking/Speed selector (#speed-toggle-btn). Shell Access (#bash-toggle-btn)
  // sits in the left cluster, so the pill lands between the two as requested.
  // Falls back to #hermes-footer if the control row isn't in the DOM yet.
  function resolveMount() {
    const speed = document.getElementById('speed-toggle-btn');
    if (speed && speed.parentElement) {
      return { parent: speed.parentElement, before: speed, inline: true };
    }
    const footer = document.getElementById('hermes-footer');
    if (footer) return { parent: footer, before: footer.firstChild, inline: false };
    return null;
  }

  function build() {
    if (_els) return _els;
    const mount = resolveMount();
    if (!mount) return null;
    injectStyles();

    const wrap = document.createElement('div');
    wrap.id = 'usage-inline-wrap';

    const bar = document.createElement('div');
    bar.id = 'usage-footer-bar';
    bar.setAttribute('role', 'button');
    bar.setAttribute('tabindex', '0');
    bar.setAttribute('aria-label', 'Session context usage');
    bar.innerHTML =
      '<span class="uf-track"><span class="uf-fill"></span></span>' +
      '<span class="uf-pct">—</span>' +
      '<span class="uf-sep">·</span>' +
      '<span class="uf-tok">—</span>' +
      '<span class="uf-costwrap"><span class="uf-sep">·</span>' +
      '<span class="uf-cost">—</span></span>' +
      '<span class="uf-compact" hidden title="Context is being compacted (auto-trimmed)">⟳ compacting</span>' +
      '<span class="uf-caret">▾</span>';

    const detail = document.createElement('div');
    detail.id = 'usage-footer-detail';

    const toggle = () => {
      _expanded = !_expanded;
      wrap.classList.toggle('uf-open', _expanded);
      bar.classList.toggle('uf-open', _expanded);
      detail.classList.toggle('uf-show', _expanded && !!_lastData);
    };
    bar.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    // Click-away closes the popover.
    document.addEventListener('click', (e) => {
      if (_expanded && !wrap.contains(e.target)) {
        _expanded = false;
        wrap.classList.remove('uf-open');
        bar.classList.remove('uf-open');
        detail.classList.remove('uf-show');
      }
    });

    wrap.appendChild(bar);
    wrap.appendChild(detail);
    mount.parent.insertBefore(wrap, mount.before);

    _els = {
      wrap, bar, detail,
      track: bar.querySelector('.uf-track'),
      fill: bar.querySelector('.uf-fill'),
      pct: bar.querySelector('.uf-pct'),
      tok: bar.querySelector('.uf-tok'),
      cost: bar.querySelector('.uf-cost'),
      compact: bar.querySelector('.uf-compact'),
    };
    return _els;
  }

  function hide() {
    if (_els) {
      _els.wrap.classList.remove('uf-show');
      _els.detail.classList.remove('uf-show');
    }
  }

  function render(data) {
    const els = build();
    if (!els) return;
    const u = data.usage || {};
    const ctx = data.context || {};
    // Expose the live context window so the per-message meta drawer
    // (chatRenderer.roleMsgMeta) can compute each message's ctx% against the
    // same denominator the footer pill uses. Borrowed from OpenClaw Control UI.
    if (ctx.windowTokens) window.__openclawCtxWindow = ctx.windowTokens;
    // Compaction badge (parity with Control UI): show while active; show a
    // brief "compacted" pip if it completed within the last ~8s, else hide.
    if (els.compact) {
      const comp = ctx.compaction || null;
      const fresh = comp && comp.phase === 'complete' && comp.completedAt
        && (Date.now() - comp.completedAt < 8000);
      const active = comp && comp.phase === 'active';
      els.compact.hidden = !(active || fresh);
      if (active) { els.compact.textContent = '⟳ compacting'; els.compact.classList.add('uf-compact--active'); }
      else if (fresh) { els.compact.textContent = '✓ compacted'; els.compact.classList.remove('uf-compact--active'); }
    }
    const pct = (ctx.usedPct != null) ? ctx.usedPct : null;
    const usedTok = (ctx.usedTokens != null) ? ctx.usedTokens : u.totalTokens;

    els.fill.style.width = `${Math.max(0, Math.min(100, pct == null ? 0 : pct))}%`;
    els.bar.classList.toggle('uf-warn', pct != null && pct >= 75 && pct < 90);
    els.bar.classList.toggle('uf-crit', pct != null && pct >= 90);
    els.track.title = `${glyphBar(pct)} ${formatPct(pct)}`;
    els.pct.textContent = formatPct(pct);
    els.tok.textContent = `${formatTokens(usedTok)} tok`;
    els.cost.textContent = formatCost(u.totalCost);

    // Compact summary tooltip on the whole bar.
    els.bar.title = [
      `Context: ${formatTokens(usedTok)} / ${formatTokens(ctx.windowTokens)} (${formatPct(pct)})`,
      `In ${formatTokens(u.inputTokens)} · Out ${formatTokens(u.outputTokens)}`,
      `${u.messages || 0} msgs · ${u.toolCalls || 0} tools`,
      data.model ? `Model: ${data.model}` : '',
    ].filter(Boolean).join('\n');

    // Expanded detail rows.
    const sysTok = (ctx.systemPromptTokens != null)
      ? ctx.systemPromptTokens
      : charsToTokens(ctx.systemPromptChars);
    const estMark = data.tokenEstimate ? ' <span class="uf-est">(est.)</span>' : '';
    const rows = [
      ['Context window', `${formatTokens(usedTok)} / ${formatTokens(ctx.windowTokens)}`],
      ['Input', formatTokens(u.inputTokens)],
      ['Output', formatTokens(u.outputTokens)],
      ['Messages', String(u.messages || 0)],
      ['Tool calls', String(u.toolCalls || 0)],
    ];
    if (u.errors) rows.push(['Errors', String(u.errors)]);
    let html = rows.map(([k, v]) =>
      `<div class="uf-row"><span>${k}</span><span>${v}</span></div>`).join('');
    if (sysTok) {
      html += `<div class="uf-row"><span>System prompt</span><span>${formatTokens(sysTok)}${estMark}</span></div>`;
    }
    if (data.model) {
      html += `<div class="uf-row"><span>Model</span><span>${data.model}</span></div>`;
    }
    els.detail.innerHTML = html;

    els.wrap.classList.add('uf-show');
    els.detail.classList.toggle('uf-show', _expanded);
  }

  // ---- Fetch --------------------------------------------------------------

  async function refresh(sid) {
    if (_inFlight) return;
    sid = sid || currentSessionId();
    _lastSid = sid;
    if (!sid) { _lastData = null; hide(); return; }
    _inFlight = true;
    try {
      const res = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sid)}/usage`, {
        headers: { 'Accept': 'application/json' },
      });
      // Stale guard: session switched mid-flight.
      if (currentSessionId() !== sid) return;
      if (!res.ok) { _lastData = null; hide(); return; }
      const data = await res.json();
      // Contract: success is always {ok:true}. Hide on anything else
      // (ok:false, an empty array from a catch-all route, null, etc.).
      if (!data || data.ok !== true) { _lastData = null; hide(); return; }
      _lastData = data;
      render(data);
    } catch (_e) {
      _lastData = null;
      hide();
    } finally {
      _inFlight = false;
    }
  }

  // ---- Poll loop ----------------------------------------------------------
  // 5s ticker: refresh on session switch, while streaming, and once on
  // run-end. Idle (no fetch) otherwise. Gated on document visibility.
  function tick() {
    if (document.hidden) return;
    const sid = currentSessionId();
    const streaming = isStreaming();
    const switched = sid !== _lastSid;
    const runEnded = _wasStreaming && !streaming;
    _wasStreaming = streaming;

    if (switched) {
      _expanded = false;
      if (_els) {
        _els.wrap.classList.remove('uf-open');
        _els.bar.classList.remove('uf-open');
        _els.detail.classList.remove('uf-show');
      }
      refresh(sid);
    } else if (streaming || runEnded) {
      refresh(sid);
    }
  }

  // ---- Peek API for the Round-1 inspector drawer --------------------------
  // Returns a human-readable system-prompt summary string for `sessionId`,
  // sourced from the last successful fetch (or null if unknown/mismatched).
  window.openclawPeekSystemPrompt = function (sessionId) {
    if (!_lastData || (sessionId && sessionId !== _lastSid)) return null;
    const ctx = _lastData.context || {};
    const chars = ctx.systemPromptChars;
    const toks = (ctx.systemPromptTokens != null)
      ? ctx.systemPromptTokens
      : charsToTokens(chars);
    if (!chars && !toks) return null;
    const est = _lastData.tokenEstimate ? ' (estimated from chars)' : '';
    const parts = [];
    if (toks) parts.push(`~${toks.toLocaleString()} tokens${est}`);
    if (chars) parts.push(`${chars.toLocaleString()} chars`);
    if (_lastData.model) parts.push(`model: ${_lastData.model}`);
    return parts.join(' · ');
  };

  // ---- Init ---------------------------------------------------------------

  function init() {
    build();
    // Immediate first paint attempt.
    refresh();
    // Refresh promptly on explicit session switch + hash navigation.
    window.addEventListener('workspace:session-switch', () => {
      _lastSid = null; // force the next tick/refresh to treat as switched
      setTimeout(() => refresh(), 50);
    });
    window.addEventListener('hashchange', () => setTimeout(() => refresh(), 50));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    setInterval(tick, POLL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
