// Pure view helpers for steering (kept DOM-free so they are unit-testable).
export function steerComposerHints(s) {
  const chat = (s && s.live && s.live.chat) || {};
  const busy = !!chat.busySessionId && chat.busySessionId === chat.activeId;
  const steer = busy && !!chat.steerMode;
  return { steerLabel: steer, showQueueChip: steer };
}

export function steerCaptionHtml(m) {
  if (!m || !m.steer) return '';
  return '<div class="msg-steer-cap" title="Delivered inside the turn that was already running">Steered into the running turn</div>';
}
