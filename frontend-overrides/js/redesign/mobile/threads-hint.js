// First-run "you can see all your threads here" hint for mobile.
//
// Points at the hamburger button in the chat header (data-act="openConvSheet")
// and explains the two ways to open the conversations drawer: tap the button,
// or swipe in from the left edge of the screen.
//
// Modeled after install-hint.js — appended to <body> so it survives root
// innerHTML rebuilds, easy to dismiss, and never shown again.

import { icon } from '../icons.js';

const KEY = 'ws:threads-hint:v1'; // 'dismissed'
const SHOW_DELAY_MS = 3400;       // let the app paint + the install-hint clear

function alreadyHandled() {
  try { return !!localStorage.getItem(KEY); } catch (_) { return false; }
}

function persistDismissed() {
  try { if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, 'dismissed'); } catch (_) {}
}

function dismiss() {
  const el = document.getElementById('threads-hint');
  if (!el) return;
  el.classList.remove('show');
  const target = document.querySelector('.m-nav-btn[data-act="openConvSheet"]');
  if (target) target.classList.remove('threads-hint-pulse');
  setTimeout(() => el.remove(), 260);
}

function build() {
  const wrap = document.createElement('div');
  wrap.id = 'threads-hint';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-label', 'Where to find your threads');

  const closeX = icon('<path d="M18 6 6 18M6 6l12 12"/>', { size: 18, sw: 2 });
  const menuGlyph = icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>', { size: 17, sw: 1.9 });

  wrap.innerHTML = `
    <div class="th-hint-scrim" data-th="later"></div>
    <div class="th-hint-arrow" aria-hidden="true"></div>
    <div class="th-hint-card">
      <button class="th-hint-close" data-th="later" aria-label="Dismiss">${closeX}</button>
      <div class="th-hint-body">
        <div class="th-hint-title">All your threads live here</div>
        <div class="th-hint-text">
          Tap the <span class="th-hint-glyph">${menuGlyph}</span> button in the top-left to see every conversation —
          or <b>swipe in from the left edge</b> of the screen.
        </div>
      </div>
      <div class="th-hint-actions">
        <button class="th-hint-btn primary" data-th="later">Got it</button>
      </div>
    </div>`;

  wrap.addEventListener('click', (e) => {
    if (!e.target.closest('[data-th]')) return;
    persistDismissed();
    dismiss();
  }, { passive: true });

  return wrap;
}

// Public entry: call once after boot. Same isMobile() the shell uses.
export function maybeShowThreadsHint(isMobile) {
  if (!isMobile || !isMobile()) return;
  if (alreadyHandled()) return;
  if (document.getElementById('threads-hint')) return;

  const tryShow = () => {
    if (!isMobile() || alreadyHandled()) return;
    // Don't stomp on the install hint — wait our turn.
    if (document.getElementById('pwa-install-hint')) { setTimeout(tryShow, 1200); return; }
    // Only useful on the chat surface, where the hamburger is actually visible.
    const target = document.querySelector('.m-nav-btn[data-act="openConvSheet"]');
    if (!target) { setTimeout(tryShow, 1200); return; }

    const el = build();
    document.body.appendChild(el);
    target.classList.add('threads-hint-pulse');
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  };

  setTimeout(tryShow, SHOW_DELAY_MS);
}
