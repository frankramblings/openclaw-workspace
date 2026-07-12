// Pure helper: maps an inbox item to a {url, kind} fetch descriptor,
// or null if this source has no in-place reader.

export function detailEndpoint(item) {
  const src = String(item && item.source || '').toLowerCase();
  const m = (item && item.meta) || {};
  if (src === 'asana')
    return { kind: 'asana', url: `/api/inbox/asana/task?gid=${encodeURIComponent(item.id)}` };
  if (src === 'slack') {
    // channelId is the real Slack conversation ID the replies endpoint needs.
    // meta.channel is ALWAYS a display name (see backend/inbox/sources/slack.py)
    // and is NOT an equivalent value — never fall back to it here, or a
    // handle_map miss silently sends a name where conversations.replies
    // requires a real channel id and the fetch fails server-side.
    // threadTs legitimately has a snake_case legacy key (thread_ts is the same
    // value, just an older field name), so that fallback stays.
    const channelId = m.channelId;
    const threadTs = m.threadTs || m.thread_ts;
    if (channelId && threadTs)
      return { kind: 'slack', url: `/api/inbox/slack/thread?channel_id=${encodeURIComponent(channelId)}&thread_ts=${encodeURIComponent(threadTs)}` };
  }
  if (src === 'gmail' && m.uid)
    return { kind: 'gmail', url: `/api/email/read/${encodeURIComponent(m.uid)}?mark_seen=false` };
  return null;
}
