// Pure helper: maps an inbox item to a {url, kind} fetch descriptor,
// or null if this source has no in-place reader.

export function detailEndpoint(item) {
  const src = String(item && item.source || '').toLowerCase();
  const m = (item && item.meta) || {};
  if (src === 'asana')
    return { kind: 'asana', url: `/api/inbox/asana/task?gid=${encodeURIComponent(item.id)}` };
  if (src === 'slack') {
    // Read camelCase first (new format), fall back to snake_case (legacy)
    const channelId = m.channelId || m.channel;
    const threadTs = m.threadTs || m.thread_ts;
    if (channelId && threadTs)
      return { kind: 'slack', url: `/api/inbox/slack/thread?channel_id=${encodeURIComponent(channelId)}&thread_ts=${encodeURIComponent(threadTs)}` };
  }
  if (src === 'gmail' && m.uid)
    return { kind: 'gmail', url: `/api/email/read/${encodeURIComponent(m.uid)}?mark_seen=false` };
  return null;
}
