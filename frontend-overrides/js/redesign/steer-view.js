// Pure view helpers for steering (kept DOM-free so they are unit-testable).
export function steerComposerHints(s) {
  const chat = (s && s.live && s.live.chat) || {};
  const busy = !!chat.busySessionId && chat.busySessionId === chat.activeId;
  const steer = busy && !!chat.steerMode;
  return { steerLabel: steer, showQueueChip: steer };
}

export function steerCaptionHtml(m) {
  if (!m || !m.steer) return '';
  const cap = '<div class="msg-steer-cap" title="Delivered inside the turn that was already running">Steered into the running turn</div>';
  // Honesty notice (chat.js maybeSteerRescue): the turn ended without ever
  // answering this steer. Rendered under the caption, never instead of it.
  const notice = m.steerNotice
    ? `<div class="msg-steer-notice">${escText(m.steerNotice)}</div>`
    : '';
  return cap + notice;
}

function escText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
