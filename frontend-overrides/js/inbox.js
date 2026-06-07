/* OpenClaw Workspace — unified Inbox tab (overlay add-on).
 *
 * Renders /api/items (gmail/slack/asana/obsidian collectors) as a triage
 * queue: per-source primary action, dismiss, snooze presets, open deep-link,
 * and "Hand to Gary" (seeds a chat session via /api/items/spinoff).
 * Self-contained like cron.js: injects #rail-inbox + its own modal, themed
 * via the SPA's CSS vars, survives Gary updates as long as #icon-rail exists.
 */
(function () {
  'use strict';
  const API = window.location.origin;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M22 12h-6l-2 3h-4l-2-3H2"/>' +
    '<path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';

  const PRIMARY = {  // per-source primary action: [action, label]
    gmail: ['archive', 'Archive'],
    slack: ['mark_read', 'Mark read'],
    asana: ['complete', 'Complete'],
    obsidian: ['reviewed', 'Reviewed'],
  };
  const REC_LABELS = {
    archive: 'Archive', delete: 'Delete', mark_read: 'Mark read',
    complete: 'Mark complete', reviewed: 'Reviewed',
    reply: 'Draft reply', gary: 'Hand to Gary',
  };
  const SNOOZES = () => {
    const now = new Date();
    const later = new Date(now); later.setHours(now.getHours() + 4);
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const nextWeek = new Date(tomorrow); nextWeek.setDate(tomorrow.getDate() + 7);
    return [['Later today', later], ['Tomorrow', tomorrow], ['Next week', nextWeek]];
  };

  /* SWIPE-MATH-BEGIN (pure — node-tested by scripts/test-swipe-math.mjs) */
  const SWIPE = {
    LOCK_PX: 10,          // movement before direction lock
    ZONE_W: 88,           // px per revealed action zone
    COMMIT_RATIO: 0.6,    // fraction of card width = full-swipe commit
    FLICK_VMIN: 0.6,      // px/ms — flick commits regardless of distance
    RUBBER: 0.5,          // resistance factor past max reveal
    SNAP_MS: 280,
    SNAP_EASE: 'cubic-bezier(0.25, 1, 0.5, 1)',
  };

  function swipeRubber(rawX, maxReveal) {
    const ax = Math.abs(rawX);
    if (ax <= maxReveal) return rawX;
    return Math.sign(rawX) * (maxReveal + (ax - maxReveal) * SWIPE.RUBBER);
  }

  function swipeVelocity(samples) {   // [{x, t}, ...] oldest first
    if (samples.length < 2) return 0;
    const a = samples[0], b = samples[samples.length - 1];
    const dt = b.t - a.t;
    return dt > 0 ? (b.x - a.x) / dt : 0;
  }

  function swipeOutcome(x, v, cardWidth) {
    const ax = Math.abs(x);
    if (ax >= cardWidth * SWIPE.COMMIT_RATIO) return 'commit';
    if (Math.abs(v) >= SWIPE.FLICK_VMIN && Math.sign(v) === Math.sign(x)
        && ax > SWIPE.LOCK_PX) return 'commit';
    if (ax >= SWIPE.ZONE_W * 0.5) return 'reveal';
    return 'rest';
  }
  /* SWIPE-MATH-END */

  // --- swipe engine (mobile only; spec §1/§3/§4) ----------------------------
  function springShut(el) {
    const content = el && $('.inbox-swipe-content', el);
    if (!content) { if (_openCard === el) _openCard = null; return; }
    content.style.transition = REDUCED_MOTION ? 'none'
      : `transform ${SWIPE.SNAP_MS}ms ${SWIPE.SNAP_EASE}`;
    content.style.transform = 'translate3d(0,0,0)';
    el._swipeX = 0;
    el.querySelectorAll('.swipe-under').forEach((u) => {
      u.classList.remove('swipe-armed');
      u.style.visibility = 'hidden';
    });
    if (_openCard === el) _openCard = null;
  }
  function closeOpenCard() { if (_openCard) springShut(_openCard); }

  async function commitSwipe(it, el, dir) {
    if (el.dataset.pending) return;
    el.dataset.pending = '1';
    const content = $('.inbox-swipe-content', el);
    content.style.transition = REDUCED_MOTION ? 'none'
      : `transform ${SWIPE.SNAP_MS}ms ${SWIPE.SNAP_EASE}`;
    content.style.transform = `translate3d(${dir * el.offsetWidth}px, 0, 0)`;
    try {
      if (dir > 0) {
        const zone = $('.swipe-under-left', el);
        const act = zone.dataset.act;
        if (act === 'reply' || act === 'gary') {
          // spinoff navigates the page on success; spring back meanwhile
          setTimeout(() => springShut(el), SWIPE.SNAP_MS);
          return await handToGary(it, zone, act);
        }
        await doAction(it, act, el, zone);
      } else {
        await doAction(it, 'dismiss', el, $('.swipe-zone-dismiss', el));
      }
      // doAction removes el on success; if it's still attached, it failed —
      // bring the card back so the user sees the ⚠ state.
      if (el.isConnected) springShut(el);
    } finally {
      delete el.dataset.pending;
    }
  }

  function bindSwipe(it, el) {
    const content = $('.inbox-swipe-content', el);
    const leftUnder = $('.swipe-under-left', el);    // shown on RIGHT swipe
    const rightUnder = $('.swipe-under-right', el);  // shown on LEFT swipe
    if (!content || !leftUnder || !rightUnder) return;
    let startX = 0, startY = 0, locked = null, baseX = 0, samples = [],
        armed = false, active = false;

    const maxReveal = (dir) => (dir > 0 ? SWIPE.ZONE_W : SWIPE.ZONE_W * 2);
    const setArmed = (on, dir) => {
      if (on === armed) return;
      armed = on;
      (dir > 0 ? leftUnder : rightUnder).classList.toggle('swipe-armed', on);
    };

    // Tapping a revealed zone fires its action.
    leftUnder.addEventListener('click', () => {
      if (_openCard !== el || el.dataset.pending) return;
      commitSwipe(it, el, 1);
    });
    $('.swipe-zone-snooze', el).addEventListener('click', (e) => {
      e.stopPropagation();
      if (_openCard !== el) return;
      snoozeMenu(it, e.target, el);
    });
    $('.swipe-zone-dismiss', el).addEventListener('click', (e) => {
      e.stopPropagation();
      if (_openCard !== el || el.dataset.pending) return;
      commitSwipe(it, el, -1);
    });

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || el.dataset.pending) return;
      if (_openCard && _openCard !== el) closeOpenCard();
      active = true;
      startX = e.clientX; startY = e.clientY;
      baseX = el._swipeX || 0;
      locked = null;
      samples = [{ x: e.clientX, t: e.timeStamp }];
    });

    el.addEventListener('pointermove', (e) => {
      if (!active || locked === 'v') return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (locked === null) {
        if (Math.abs(dx) < SWIPE.LOCK_PX && Math.abs(dy) < SWIPE.LOCK_PX) return;
        locked = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
        if (locked === 'v') return;            // native scroll owns it now
        try { el.setPointerCapture(e.pointerId); } catch (_) { /* fine */ }
      }
      samples.push({ x: e.clientX, t: e.timeStamp });
      if (samples.length > 5) samples.shift();
      const raw = baseX + dx;
      const dir = raw >= 0 ? 1 : -1;
      const x = swipeRubber(raw, maxReveal(dir));
      content.style.transition = 'none';
      content.style.transform = `translate3d(${x}px, 0, 0)`;
      el._swipeX = x;
      leftUnder.style.visibility = raw > 0 ? 'visible' : 'hidden';
      rightUnder.style.visibility = raw < 0 ? 'visible' : 'hidden';
      setArmed(Math.abs(raw) >= el.offsetWidth * SWIPE.COMMIT_RATIO, dir);
    });

    const finish = () => {
      if (!active) return;
      active = false;
      if (locked !== 'h') { locked = null; return; }
      locked = null;
      el._suppressClick = true;   // the click after a drag is not a tap
      const x = el._swipeX || 0;
      const v = swipeVelocity(samples);
      const out = swipeOutcome(x, v, el.offsetWidth);
      if (out === 'commit') { commitSwipe(it, el, x > 0 ? 1 : -1); return; }
      if (out === 'reveal') {
        const dir = x > 0 ? 1 : -1;
        const content2 = $('.inbox-swipe-content', el);
        content2.style.transition = REDUCED_MOTION ? 'none'
          : `transform ${SWIPE.SNAP_MS}ms ${SWIPE.SNAP_EASE}`;
        content2.style.transform = `translate3d(${dir * maxReveal(dir)}px, 0, 0)`;
        el._swipeX = dir * maxReveal(dir);
        setArmed(false, dir);
        _openCard = el;
        return;
      }
      springShut(el);
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', () => {
      active = false; locked = null; springShut(el);
    });

    // Swallow the synthetic click that follows a horizontal drag so buttons
    // under the finger don't fire (tap passthrough stays: no drag, no flag).
    el.addEventListener('click', (e) => {
      if (el._suppressClick) {
        el._suppressClick = false;
        e.stopPropagation(); e.preventDefault();
      }
    }, true);
  }

  let _modal = null, _items = [], _errors = {}, _counts = {}, _filter = null,
      _view = 'feed', _toastTimer = null, _openCard = null;
  const IS_COARSE = !!(window.matchMedia
    && matchMedia('(pointer: coarse)').matches);
  const REDUCED_MOTION = !!(window.matchMedia
    && matchMedia('(prefers-reduced-motion: reduce)').matches);

  function ageLabel(h) {
    if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
    if (h < 48) return `${Math.round(h)}h`;
    return `${Math.round(h / 24)}d`;
  }

  function buildModal() {
    if (_modal) return _modal;
    const overlay = document.createElement('div');
    overlay.id = 'inbox-modal';
    overlay.className = 'cron-modal-overlay';   // reuse modal chrome styles
    overlay.style.display = 'none';
    overlay.innerHTML =
      '<div class="cron-modal-card inbox-card" role="dialog" aria-label="Inbox">' +
      '  <div class="cron-modal-head">' +
      '    <span class="cron-modal-title">Inbox</span>' +
      '    <span class="inbox-chips" id="inbox-chips"></span>' +
      '    <button class="inbox-refresh" id="inbox-triage-btn" title="✨ AI triage">&#x2728;</button>' +
      '    <button class="inbox-refresh" id="inbox-history-btn" title="History">&#x1F552;</button>' +
      '    <button class="inbox-refresh" id="inbox-refresh" title="Refresh">&#x21bb;</button>' +
      '    <button class="cron-modal-close" id="inbox-close" title="Close">&#x2715;</button>' +
      '  </div>' +
      '  <div class="cron-modal-body" id="inbox-body"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    $('#inbox-close', overlay).addEventListener('click', close);
    $('#inbox-refresh', overlay).addEventListener('click', () => load(true));
    $('#inbox-triage-btn', overlay).addEventListener('click', runTriage);
    $('#inbox-history-btn', overlay).addEventListener('click', toggleHistory);
    // Scroll or a touch outside the revealed card closes it (iOS behavior).
    $('#inbox-body', overlay).addEventListener('scroll', closeOpenCard,
                                               { passive: true });
    overlay.addEventListener('pointerdown', (e) => {
      if (_openCard && !_openCard.contains(e.target)) closeOpenCard();
    }, true);
    _modal = overlay;
    return overlay;
  }

  function open() {
    buildModal().style.display = 'flex';
    document.addEventListener('keydown', onEsc);
    load(false);
  }
  function close() {
    if (_modal) _modal.style.display = 'none';
    document.removeEventListener('keydown', onEsc);
  }
  function onEsc(e) { if (e.key === 'Escape') close(); }

  async function load(force) {
    _view = 'feed';
    const body = $('#inbox-body');
    if (body && !_items.length) body.innerHTML = '<div class="cron-empty">Loading…</div>';
    try {
      const r = await fetch(`${API}/api/items?limit=200${force ? '&_=' + Date.now() : ''}`,
        { credentials: 'same-origin' });
      const data = await r.json();
      _items = data.items || [];
      _errors = data.errors || {};
      _counts = data.sources || {};
    } catch (e) {
      _items = []; _errors = { inbox: String(e) };
    }
    render();
  }

  function render() {
    if (_view === 'history') return renderHistory();
    _openCard = null;   // rebuilt DOM: any revealed card is gone with it
    renderChips();
    const body = $('#inbox-body');
    if (!body) return;
    const items = _filter ? _items.filter(i => i.source === _filter) : _items;
    if (!items.length) {
      const errs = Object.entries(_errors)
        .map(([s, e]) => `<div class="inbox-error">${esc(s)}: ${esc(e)}</div>`).join('');
      body.innerHTML = `<div class="cron-empty">Inbox zero 🎉</div>${errs}`;
      return;
    }
    body.innerHTML = items.map(cardHtml).join('');
    items.forEach((it) => bindCard(it));
  }

  function renderChips() {
    const chips = $('#inbox-chips');
    if (!chips) return;
    chips.innerHTML = Object.keys(_counts).map((s) => {
      const err = _errors[s] ? ' inbox-chip-err' : '';
      const active = _filter === s ? ' inbox-chip-active' : '';
      const title = _errors[s] ? esc(_errors[s]) : `${_counts[s]} items`;
      return `<button class="inbox-chip email-tag-${s}${err}${active}" ` +
             `data-src="${s}" title="${title}">${s} ${_counts[s] ?? 0}` +
             `${_errors[s] ? ' ⚠' : ''}</button>`;
    }).join('');
    chips.querySelectorAll('.inbox-chip').forEach((b) => {
      b.addEventListener('click', () => {
        _filter = _filter === b.dataset.src ? null : b.dataset.src;
        render();
      });
    });
  }

  // Per-card swipe under-layers (spec §2). Right swipe reveals the LEFT layer
  // (one zone: ✨ rec action when present, else the static primary); left
  // swipe reveals the RIGHT layer (Snooze | Dismiss, Dismiss outermost).
  // Inert on desktop: display:none outside (pointer: coarse).
  const SWIPE_ACTIONS = ['archive', 'delete', 'mark_read', 'complete',
                         'reviewed', 'reply', 'gary'];
  function zoneHtml(it) {
    const rec = it.rec && SWIPE_ACTIONS.includes(it.rec.action) ? it.rec : null;
    const [pAct, pLabel] = PRIMARY[it.source] || ['dismiss', 'Done'];
    const right = rec
      ? { act: rec.action, label: '✨ ' + (REC_LABELS[rec.action] || rec.action),
          cls: 'swipe-zone-rec' }
      : { act: pAct, label: pLabel, cls: 'swipe-zone-primary' };
    return (
      `<div class="swipe-under swipe-under-left ${right.cls}" data-act="${esc(right.act)}">` +
      `<span class="swipe-zone-label">${esc(right.label)}</span></div>` +
      `<div class="swipe-under swipe-under-right">` +
      `<button class="swipe-zone swipe-zone-snooze" data-zone="snooze">Snooze</button>` +
      `<button class="swipe-zone swipe-zone-dismiss" data-zone="dismiss">Dismiss</button>` +
      `</div>`);
  }

  function cardHtml(it) {
    const [act, label] = PRIMARY[it.source] || ['dismiss', 'Done'];
    return (
      `<div class="inbox-item" data-id="${esc(it.id)}" data-src="${esc(it.source)}">` +
      zoneHtml(it) +
      `<div class="inbox-swipe-content">` +
      `  <div class="inbox-item-main">` +
      `    <div class="inbox-item-title">` +
      `      <span class="email-tag email-tag-${esc(it.source)}">${esc(it.source)}</span>` +
      `      ${esc(it.title)}</div>` +
      `    <div class="inbox-item-sub">${esc(it.subtitle || '')}` +
      `      <span class="inbox-age">· ${ageLabel(it.ageHours)}</span></div>` +
      (it.snippet ? `<div class="inbox-item-snip">${esc(it.snippet)}</div>` : '') +
      (it.rec ? `    <div class="inbox-rec-chip${it.rec.confidence === 'low' ? ' inbox-rec-low' : ''}" ` +
                `role="button" tabindex="0" title="${esc(it.rec.by)} recommendation">` +
                `✨ ${esc(REC_LABELS[it.rec.action] || it.rec.action)}` +
                (it.rec.reason ? ` — ${esc(it.rec.reason)}` : '') + `</div>` : '') +
      `  </div>` +
      `  <div class="inbox-item-actions">` +
      `    <button data-act="${act}" class="inbox-btn inbox-btn-primary">${label}</button>` +
      ((it.actions || []).includes('delete')
        ? `    <button data-act="delete" class="inbox-btn" title="Delete">🗑</button>` : '') +
      `    <button data-act="snooze" class="inbox-btn" title="Snooze">⏰</button>` +
      `    <button data-act="open" class="inbox-btn" title="Open">↗</button>` +
      `    <button data-act="gary" class="inbox-btn" title="Hand to Gary">🤖</button>` +
      `    <button data-act="dismiss" class="inbox-btn" title="Dismiss">✕</button>` +
      `  </div>` +
      `</div>` +
      `</div>`);
  }

  function bindCard(it) {
    const el = $(`.inbox-item[data-id="${CSS.escape(it.id)}"][data-src="${it.source}"]`);
    if (!el) return;
    el.querySelectorAll('.inbox-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'open') return openItem(it, btn);
        if (act === 'gary') return handToGary(it, btn);
        if (act === 'snooze') return snoozeMenu(it, btn, el);
        await doAction(it, act, el, btn);
      });
    });
    const chip = $('.inbox-rec-chip', el);
    if (chip && it.rec) {
      const fire = async () => {
        if (chip.dataset.pending) return;   // divs ignore .disabled — guard double-fire
        chip.dataset.pending = '1';
        chip.style.opacity = '0.5';
        try {
          if (it.rec.action === 'reply' || it.rec.action === 'gary') {
            return await handToGary(it, chip, it.rec.action);
          }
          await doAction(it, it.rec.action, el, chip);
        } finally {
          delete chip.dataset.pending;
          chip.style.opacity = '';
        }
      };
      chip.addEventListener('click', fire);
      chip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); }
      });
    }
    if (IS_COARSE) bindSwipe(it, el);
  }

  async function doAction(it, act, el, btn, until) {
    btn.disabled = true;
    try {
      const r = await fetch(`${API}/api/items/action`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: it.source, id: it.id, action: act,
                               until, title: it.title, meta: it.meta || {} }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
      el.style.opacity = '0.3';
      setTimeout(() => { el.remove(); }, 200);
      _items = _items.filter((x) => !(x.id === it.id && x.source === it.source));
      _counts[it.source] = Math.max(0, (_counts[it.source] || 1) - 1);
      renderChips();
      showToast(`${act === 'snooze' ? 'Snoozed' : act.replace('_', ' ')} — "${(it.title || '').slice(0, 40)}"`,
                data.undoTs);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '⚠';
      btn.title = String(err.message || err);
    }
  }

  function snoozeMenu(it, btn, el) {
    const existing = $('.inbox-snooze-menu', el);
    if (existing) { existing.remove(); return; }
    const menu = document.createElement('div');
    menu.className = 'inbox-snooze-menu';
    SNOOZES().forEach(([label, when]) => {
      const b = document.createElement('button');
      b.className = 'inbox-btn';
      b.textContent = label;
      b.addEventListener('click', () =>
        doAction(it, 'snooze', el, btn, when.getTime()));
      menu.appendChild(b);
    });
    el.appendChild(menu);
  }

  async function openItem(it, btn) {
    let url = it.meta && it.meta.url;
    if (!url && it.source === 'gmail' && it.meta && it.meta.uid) {
      btn.disabled = true;
      try {
        const r = await fetch(
          `${API}/api/email/read/${encodeURIComponent(it.meta.uid)}?mark_seen=false`,
          { credentials: 'same-origin' });
        const data = await r.json();
        const mid = (data.message_id || '').replace(/^<|>$/g, '');
        if (mid) url = `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(mid)}`;
      } catch (_) { /* fall through */ }
      btn.disabled = false;
      if (!url) url = 'https://mail.google.com/mail/u/0/#inbox';
    }
    if (url) window.open(url, '_blank');
  }

  async function handToGary(it, btn, intent) {
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = '…';
    try {
      const r = await fetch(`${API}/api/items/spinoff`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item: it, intent: intent || undefined }),
      });
      const data = await r.json();
      if (!r.ok || !data.session_id) throw new Error(data.detail || 'no session');
      window.location.hash = '#' + data.session_id;
      window.location.reload();
    } catch (err) {
      btn.disabled = false; btn.textContent = orig;
      btn.title = 'Failed: ' + String(err.message || err);
    }
  }

  // --- undo toast + history drawer ----------------------------------------
  function showToast(msg, undoTs) {
    const card = $('.inbox-card', _modal);
    if (!card) return;
    const old = $('#inbox-toast', card);
    if (old) old.remove();
    clearTimeout(_toastTimer);
    const t = document.createElement('div');
    t.id = 'inbox-toast';
    t.innerHTML = `<span>${esc(msg)}</span>`;
    if (undoTs) {
      const b = document.createElement('button');
      b.className = 'inbox-btn inbox-toast-undo';
      b.textContent = 'Undo';
      b.addEventListener('click', async () => { await doUndo(undoTs); t.remove(); });
      t.appendChild(b);
    }
    card.appendChild(t);
    _toastTimer = setTimeout(() => t.remove(), 8000);
  }

  async function doUndo(ts) {
    try {
      const r = await fetch(`${API}/api/items/undo`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ts }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showToast('Undone — item restored', null);
      load(true);
    } catch (err) {
      showToast('Undo failed: ' + String(err.message || err), null);
    }
  }

  async function runTriage() {
    const btn = $('#inbox-triage-btn', _modal);
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    const orig = btn.innerHTML;
    btn.innerHTML = '…';
    try {
      const r = await fetch(`${API}/api/items/triage`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showToast(`✨ scored ${data.scored} item${data.scored === 1 ? '' : 's'}`, null);
      await load(true);
    } catch (err) {
      showToast('Triage failed: ' + String(err.message || err), null);
    }
    btn.disabled = false;
    btn.innerHTML = orig;
  }

  function toggleHistory() {
    _view = _view === 'history' ? 'feed' : 'history';
    if (_view === 'feed') { render(); return; }
    renderHistory();
  }

  async function renderHistory() {
    const body = $('#inbox-body');
    if (!body) return;
    body.innerHTML = '<div class="cron-empty">Loading…</div>';
    let entries = [];
    try {
      const r = await fetch(`${API}/api/items/history?limit=20`,
        { credentials: 'same-origin' });
      entries = (await r.json()).entries || [];
    } catch (e) {
      body.innerHTML = `<div class="inbox-error">${esc(String(e))}</div>`;
      return;
    }
    if (!entries.length) {
      body.innerHTML = '<div class="cron-empty">No recent actions.</div>';
      return;
    }
    body.innerHTML = entries.map((e) =>
      `<div class="inbox-item inbox-hist-row" data-ts="${e.ts}">` +
      `  <div class="inbox-item-main">` +
      `    <div class="inbox-item-title">` +
      `      <span class="email-tag email-tag-${esc(e.source)}">${esc(e.source)}</span>` +
      `      ${esc(e.action.replace('_', ' '))} · ${esc(e.title || '(untitled)')}</div>` +
      `    <div class="inbox-item-sub">${ageLabel((Date.now() - e.ts) / 3600000)} ago` +
      (e.note ? ` · ${esc(e.note)}` : '') + `</div>` +
      `  </div>` +
      `  <div class="inbox-item-actions">` +
      (e.undoable
        ? `<button class="inbox-btn inbox-hist-undo" data-ts="${e.ts}">Undo</button>`
        : `<span class="inbox-item-sub">not undoable</span>`) +
      `  </div></div>`).join('');
    body.querySelectorAll('.inbox-hist-undo').forEach((b) => {
      b.addEventListener('click', async () => {
        b.disabled = true;
        await doUndo(Number(b.dataset.ts));
        // doUndo's load(true) flipped us to the feed (showing the restored
        // card); only re-render the drawer if we're somehow still in it.
        if (_view === 'history') renderHistory();
      });
    });
  }

  // --- rail button (same injection style as cron.js) ------------------------
  function injectRailButton() {
    const rail = $('#icon-rail');
    if (!rail || $('#rail-inbox')) return;
    const btn = document.createElement('button');
    btn.id = 'rail-inbox';
    btn.className = 'icon-rail-btn';   // matches cron.js: 'icon-rail-btn'
    btn.title = 'Inbox';
    btn.innerHTML = ICON;
    btn.addEventListener('click', open);
    // Place before #rail-theme (same strategy as cron.js uses for its button).
    const theme = $('#rail-theme', rail);
    if (theme) rail.insertBefore(btn, theme); else rail.appendChild(btn);
  }

  // Expanded-sidebar entry (#inbox-section in index.html) — the rail button
  // only exists when the sidebar is collapsed, so this is the discoverable way in.
  function bindSidebarEntry() {
    const title = document.getElementById('inbox-section-title');
    if (title && !title._inboxBound) {
      title._inboxBound = true;
      title.addEventListener('click', open);
    }
  }

  function init() {
    injectRailButton();
    bindSidebarEntry();
    // Re-inject if the SPA re-renders the rail and our button vanishes.
    const rail = document.getElementById('icon-rail');
    if (rail && window.MutationObserver) {
      new MutationObserver(() => {
        if (!document.getElementById('rail-inbox')) injectRailButton();
      }).observe(rail, { childList: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
