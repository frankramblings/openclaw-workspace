// Pure context builders for composer ghost suggestions. DOM-free on purpose:
// the fetch wrapper lives in live/chat.js (api.js touches `location` at module
// scope and would break the node test runner if imported from here).

const MAX_CONTEXT = 4000;

// {role, text} thread → "User: …\n\nAssistant: …", tail-capped at 4000 chars.
// `extra` (midturn activity summary) is appended last so it survives the cap.
export function buildSuggestContext(thread, extra = '') {
  const lines = [];
  for (const m of Array.isArray(thread) ? thread : []) {
    const text = String((m && m.text) || '').trim();
    if (!text) continue;
    lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
  }
  let ctx = lines.join('\n\n');
  if (extra) ctx = ctx ? `${ctx}\n\n${extra}` : extra;
  return ctx.length > MAX_CONTEXT ? ctx.slice(-MAX_CONTEXT) : ctx;
}

// Live activity trail → a short "what the assistant is doing" block for the
// midturn prompt. Last 6 steps is plenty of signal for one suggestion.
export function activitySummary(activity) {
  const steps = activity && Array.isArray(activity.steps) ? activity.steps : [];
  const labels = steps.slice(-6)
    .map((st) => [st.label, st.file].filter(Boolean).join(' ').trim())
    .filter(Boolean);
  if (!labels.length) return '';
  return `Assistant is still working. Recent activity:\n${labels.map((l) => `- ${l}`).join('\n')}`;
}
