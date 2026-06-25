// Pure helper: maps an inbox item to a {url, kind} fetch descriptor,
// or null if this source has no in-place reader.

export function detailEndpoint(item) {
  const src = String(item && item.source || '').toLowerCase();
  const m = (item && item.meta) || {};
  if (src === 'asana')
    return { kind: 'asana', url: `/api/inbox/asana/task?gid=${encodeURIComponent(item.id)}` };
  if (src === 'slack' && m.channel && m.thread_ts)
    return { kind: 'slack', url: `/api/inbox/slack/thread?channel_id=${encodeURIComponent(m.channel)}&thread_ts=${encodeURIComponent(m.thread_ts)}` };
  if (src === 'gmail' && m.uid)
    return { kind: 'gmail', url: `/api/email/read/${encodeURIComponent(m.uid)}?mark_seen=false` };
  return null;
}
