// Fullscreen image viewer for the redesign UI (mobile + desktop).
//
// The redesign doesn't load the classic vaultLinks.js, so it needs its own
// lightbox. Used for: tapping an inline shared image (MEDIA:/data-URI), and
// opening an image file from chat/explorer (instead of the text editor, which
// would show garbage and — before the backend guard — corrupt the file on save).
//
// CSS lives in redesign.css (.rnd-imgview*).

function nameFromSrc(src) {
  try {
    const u = new URL(src, window.location.origin);
    const p = u.searchParams.get('path');
    return (p || u.pathname).split('/').pop() || '';
  } catch (_e) {
    return '';
  }
}

export function openImageOverlay(src, name) {
  if (!src) return;
  const label = name || nameFromSrc(src);
  const overlay = document.createElement('div');
  overlay.className = 'rnd-imgview';
  overlay.innerHTML =
    '<div class="rnd-imgview-bar">' +
      '<span class="rnd-imgview-name"></span>' +
      '<span class="rnd-imgview-actions">' +
        '<a class="rnd-imgview-open" target="_blank" rel="noopener">Open in browser ↗</a>' +
        '<a class="rnd-imgview-dl" download>Download</a>' +
        '<button type="button" class="rnd-imgview-close" aria-label="Close">✕</button>' +
      '</span>' +
    '</div>' +
    '<div class="rnd-imgview-stage"><img alt=""></div>';
  overlay.querySelector('.rnd-imgview-name').textContent = label;
  overlay.querySelector('.rnd-imgview-open').href = src;
  overlay.querySelector('.rnd-imgview-dl').href = src;
  const img = overlay.querySelector('img');
  img.src = src;
  img.addEventListener('error', () => {
    overlay.querySelector('.rnd-imgview-stage').innerHTML =
      '<div class="rnd-imgview-err">Couldn’t load this image.<br>' +
      'Try <strong>Open in browser</strong> or <strong>Download</strong> above.</div>';
  });

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  overlay.addEventListener('click', (e) => {
    const t = e.target;
    if (t === overlay || t.classList.contains('rnd-imgview-stage') ||
        t.classList.contains('rnd-imgview-close')) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}
