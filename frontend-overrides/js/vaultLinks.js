// Vault file links in chat → open the right way for their type.
//
// The agent links files it writes by vault path (absolute, ~, or relative —
// e.g. [radar](~/.openclaw/workspace/memory/proactive-drafts/x.md), or an
// image like [specimen](~/.openclaw/workspace/tmp/x.png)).
// markdown.js renders every anchor target="_blank", so those links would
// otherwise navigate a new tab to a 404. This add-on (same pattern as
// cron.js/inbox.js) intercepts them in the chat history. Capture phase so we
// beat the _blank navigation.
//
// Routing by type:
//   • images  → open in an in-page image viewer (lightbox) served by the
//     allow-listed /api/workspace-media (abs/~) or /api/workspace/file (rel).
//     Worst case the viewer's "Open in browser" link opens it as a real
//     image/* response in a new tab.
//   • text    → open via GET /api/vault/open, which wraps it as a real library
//     doc (edits mirror back to the file; reopening refreshes from disk).
//
// Note: /api/vault/open is NOT reliably content-gated (read_text can succeed on
// binary), so the image branch here is what actually keeps PNGs/JPEGs out of
// the text editor. The backend also rejects known-binary extensions as a
// second line of defence (see documents.py). Explicit vault references
// intercept unconditionally; bare relative paths still need a known extension
// so ordinary same-origin app links keep navigating.
(function () {
  const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;
  const TEXT_RE = /\.(md|txt|json|py|js|mjs|ts|css|html|sh|yaml|yml|toml|ini|csv|log|skill)(\.bak)?$/i;

  function vaultPath(rawHref) {
    if (!rawHref) return null;
    let path = rawHref;
    if (/^https?:/i.test(rawHref)) {
      // markdown.js's safeLinkUrl absolutizes every href against the page
      // origin (new URL(url, origin)), so a filesystem path like
      // /Users/.../workspace/x.md reaches the DOM as https://<host>/Users/...
      // Same-origin → recover the pathname; foreign origin → a real web link.
      let u;
      try { u = new URL(rawHref); } catch (_e) { return null; }
      if (u.origin !== window.location.origin) return null;
      try { path = decodeURIComponent(u.pathname); } catch (_e) { path = u.pathname; }
    } else if (/^(mailto|tel|blob|data|javascript):/i.test(rawHref)) {
      return null;
    }
    const bare = path.split('?')[0].split('#')[0];
    const explicitVaultRef = bare.includes('.openclaw/workspace/') || /^~\//.test(bare);
    if (!explicitVaultRef && !TEXT_RE.test(bare) && !IMG_RE.test(bare)) return null;
    return bare;
  }

  // abs/~ paths → the allow-listed media route (same one MEDIA: inline uses);
  // bare relative paths are vault-relative → the workspace file server.
  function mediaUrl(path) {
    return /^([~/]|[A-Za-z]:[\\/])/.test(path)
      ? '/api/workspace-media?path=' + encodeURIComponent(path)
      : '/api/workspace/file?path=' + encodeURIComponent(path);
  }

  function ensureStyle() {
    if (document.getElementById('vl-img-style')) return;
    const s = document.createElement('style');
    s.id = 'vl-img-style';
    s.textContent = `
.vl-img-overlay{position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;
  background:rgba(12,12,14,.86);backdrop-filter:blur(4px);animation:vlFade .12s ease-out}
@keyframes vlFade{from{opacity:0}to{opacity:1}}
.vl-img-bar{display:flex;align-items:center;gap:12px;padding:10px 16px;color:#eee;
  font:13px/1.4 ui-sans-serif,system-ui,sans-serif}
.vl-img-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85}
.vl-img-actions{display:flex;align-items:center;gap:14px;flex:none}
.vl-img-actions a{color:#9cc4ff;text-decoration:none}
.vl-img-actions a:hover{text-decoration:underline}
.vl-img-close{background:none;border:0;color:#eee;font-size:18px;line-height:1;cursor:pointer;
  padding:2px 6px;border-radius:6px}
.vl-img-close:hover{background:rgba(255,255,255,.12)}
.vl-img-stage{flex:1;display:flex;align-items:center;justify-content:center;overflow:auto;
  padding:0 20px 24px;cursor:zoom-out}
.vl-img-stage img{max-width:95%;max-height:100%;object-fit:contain;border-radius:8px;
  box-shadow:0 8px 40px rgba(0,0,0,.5);background:#fff;cursor:default}
.vl-img-err{color:#f3b1b1;font:14px/1.5 ui-sans-serif,system-ui,sans-serif;text-align:center}`;
    document.head.appendChild(s);
  }

  function openImageViewer(path) {
    openImageViewerSrc(mediaUrl(path), path.split('/').pop() || path);
  }

  function openImageViewerSrc(src, name) {
    ensureStyle();
    const overlay = document.createElement('div');
    overlay.className = 'vl-img-overlay';
    overlay.innerHTML =
      '<div class="vl-img-bar">' +
        '<span class="vl-img-name"></span>' +
        '<span class="vl-img-actions">' +
          '<a class="vl-img-open" target="_blank" rel="noopener">Open in browser ↗</a>' +
          '<a class="vl-img-dl" download>Download</a>' +
          '<button type="button" class="vl-img-close" aria-label="Close">✕</button>' +
        '</span>' +
      '</div>' +
      '<div class="vl-img-stage"><img alt=""></div>';
    overlay.querySelector('.vl-img-name').textContent = name || '';
    overlay.querySelector('.vl-img-open').href = src;
    overlay.querySelector('.vl-img-dl').href = src;
    const img = overlay.querySelector('img');
    img.src = src;
    img.addEventListener('error', () => {
      const stage = overlay.querySelector('.vl-img-stage');
      stage.innerHTML = '<div class="vl-img-err">Couldn’t load this image.<br>' +
        'Try <strong>Open in browser</strong> or <strong>Download</strong> above.</div>';
    });

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', (e) => {
      const t = e.target;
      if (t === overlay || t.classList.contains('vl-img-stage') ||
          t.classList.contains('vl-img-close')) close();
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  }

  async function openVaultDoc(path, anchor) {
    try {
      const res = await fetch('/api/vault/open?path=' + encodeURIComponent(path),
        { credentials: 'same-origin' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      const dm = window.documentModule;
      if (dm && dm.injectFreshDoc) dm.injectFreshDoc(data);
    } catch (err) {
      anchor.title = 'Could not open: ' + String(err.message || err);
      anchor.style.opacity = '0.6';
    }
  }

  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const chat = document.getElementById('chat-history');
    if (!chat || !chat.contains(a)) return;
    const path = vaultPath(a.getAttribute('href'));
    if (!path) return;
    e.preventDefault();
    e.stopPropagation();
    if (IMG_RE.test(path)) openImageViewer(path);
    else openVaultDoc(path, a);
  }, true);

  // Tapping an inline shared image (MEDIA:/data-URI) opens it fullscreen.
  // Works in any chat surface (desktop + mobile redesign), not just #chat-history.
  document.addEventListener('click', (e) => {
    const img = e.target && e.target.closest && e.target.closest('.shared-image img');
    if (!img || !img.src) return;
    e.preventDefault();
    e.stopPropagation();
    let name = '';
    try {
      const u = new URL(img.src, window.location.origin);
      const p = u.searchParams.get('path');
      name = (p || u.pathname).split('/').pop() || '';
    } catch (_e) { /* data: URLs etc. — no name */ }
    openImageViewerSrc(img.src, name);
  }, true);
})();
