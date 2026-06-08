// Vault .md links in chat → open in the document editor.
//
// The agent links files it writes by vault path (absolute, ~, or relative —
// e.g. [radar](~/.openclaw/workspace/memory/proactive-drafts/x.md)).
// markdown.js renders every anchor target="_blank", so those links navigated a
// new tab to a 404. This add-on (same pattern as cron.js/inbox.js) intercepts
// them in the chat history and opens the file via GET /api/vault/open, which
// wraps it as a real library doc (edits mirror back to the file; reopening
// refreshes from disk). Capture phase so we beat the _blank navigation.
(function () {
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
    if (!/\.md$/i.test(bare)) return null;
    return bare;
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
    openVaultDoc(path, a);
  }, true);
})();
