// First-run "Add to Home Screen" hint for mobile.
//
// Shows a small, non-disruptive bottom card the FIRST time someone opens the
// workspace in a mobile browser (not already installed), explaining how to add
// the PWA to their home screen. Easy to dismiss (X, "Not now", or backdrop tap)
// and never shown again once dismissed or once the app is installed.
//
// The card is appended to <body> — NOT into the app root — so it survives the
// wholesale root.innerHTML rebuilds that render() does.

import { icon } from '../icons.js';

const KEY = 'ws:pwa-install-hint:v1'; // 'dismissed' | 'installed'
const SHOW_DELAY_MS = 2600; // let the app paint first — non-disruptive

// Capture the Android/Chromium install prompt as early as this module loads, so
// we can offer a real one-tap "Install" button instead of manual instructions.
// (On iOS Safari this event never fires and we fall back to the Share steps.)
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});
window.addEventListener('appinstalled', () => {
  try { localStorage.setItem(KEY, 'installed'); } catch (_) {}
  dismiss();
});

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  window.navigator.standalone === true;

const isIOS = () => {
  const ua = navigator.userAgent || '';
  // iPadOS 13+ masquerades as Mac; disambiguate via touch points.
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return /iphone|ipad|ipod/i.test(ua) || iPadOS;
};

function alreadyHandled() {
  try { return !!localStorage.getItem(KEY); } catch (_) { return false; }
}

function persistDismissed() {
  try { if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, 'dismissed'); } catch (_) {}
}

function dismiss() {
  const el = document.getElementById('pwa-install-hint');
  if (!el) return;
  el.classList.remove('show');
  setTimeout(() => el.remove(), 260);
}

// iOS Safari share glyph (rounded square + up arrow) so the copy can point at
// the exact button they'll tap.
const shareGlyph = icon('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 12v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7"/>', { size: 17, sw: 1.9 });

function build() {
  const wrap = document.createElement('div');
  wrap.id = 'pwa-install-hint';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-label', 'Add to Home Screen');

  const closeX = icon('<path d="M18 6 6 18M6 6l12 12"/>', { size: 18, sw: 2 });

  let body;
  if (deferredPrompt) {
    // Android / Chromium — offer a real one-tap install.
    body = `
      <div class="pwa-hint-body">
        <div class="pwa-hint-title">Install the workspace</div>
        <div class="pwa-hint-text">Add it to your home screen for a full-screen, app-like experience.</div>
      </div>
      <div class="pwa-hint-actions">
        <button class="pwa-hint-btn ghost" data-pwa="later">Not now</button>
        <button class="pwa-hint-btn primary" data-pwa="install">Install</button>
      </div>`;
  } else if (isIOS()) {
    // iOS Safari — no programmatic install; show the Share → Add steps.
    body = `
      <div class="pwa-hint-body">
        <div class="pwa-hint-title">Add to Home Screen</div>
        <div class="pwa-hint-text">Tap <span class="pwa-hint-glyph">${shareGlyph}</span> in the toolbar, then choose <b>Add to Home Screen</b>.</div>
      </div>
      <div class="pwa-hint-actions">
        <button class="pwa-hint-btn primary" data-pwa="later">Got it</button>
      </div>`;
  } else {
    // Other mobile browsers — generic guidance via the browser menu.
    body = `
      <div class="pwa-hint-body">
        <div class="pwa-hint-title">Add to Home Screen</div>
        <div class="pwa-hint-text">Open your browser menu, then choose <b>Add to Home screen</b> or <b>Install app</b>.</div>
      </div>
      <div class="pwa-hint-actions">
        <button class="pwa-hint-btn primary" data-pwa="later">Got it</button>
      </div>`;
  }

  wrap.innerHTML = `
    <div class="pwa-hint-scrim" data-pwa="later"></div>
    <div class="pwa-hint-card">
      <button class="pwa-hint-close" data-pwa="later" aria-label="Dismiss">${closeX}</button>
      ${body}
    </div>`;

  wrap.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-pwa]');
    if (!act) return;
    const kind = act.getAttribute('data-pwa');
    if (kind === 'install' && deferredPrompt) {
      const p = deferredPrompt;
      deferredPrompt = null;
      dismiss();
      try {
        p.prompt();
        const { outcome } = await p.userChoice;
        try { localStorage.setItem(KEY, outcome === 'accepted' ? 'installed' : 'dismissed'); } catch (_) {}
      } catch (_) { persistDismissed(); }
      return;
    }
    // "later" / "Got it" / X / backdrop
    persistDismissed();
    dismiss();
  }, { passive: true });

  return wrap;
}

// Public entry: call once after boot. `isMobile()` is passed in from app.js so we
// share the exact same breakpoint as the shell.
export function maybeShowInstallHint(isMobile) {
  if (!isMobile || !isMobile()) return;      // mobile shell only
  if (isStandalone()) return;                 // already installed / launched from home screen
  if (alreadyHandled()) return;               // shown & dismissed before, or installed
  if (document.getElementById('pwa-install-hint')) return;

  setTimeout(() => {
    // Re-check: the viewport may have widened, or it may have been installed in
    // the meantime (e.g. appinstalled fired during the delay).
    if (!isMobile() || isStandalone() || alreadyHandled()) return;
    const el = build();
    document.body.appendChild(el);
    // next frame → trigger the slide-up transition
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  }, SHOW_DELAY_MS);
}
