// Settings → Projects card body: suggested projects (proposals) + the project list.
import { esc, map } from './dom.js';

export function proposalRowHtml(p) {
  const n = Number(p.count) || 0;
  const samples = Array.isArray(p.sample_titles) ? p.sample_titles.filter(Boolean).slice(0, 3) : [];
  return `<div class="set-proj-row set-proposal" data-proposal="${esc(p.id)}">
    <span class="nm">${esc(p.name)} <span class="set-muted">${n} conversation${n === 1 ? '' : 's'}</span></span>
    <button class="set-btn primary" data-act="projectsAccept" data-arg="${esc(p.id)}">Accept</button>
    <button class="set-btn" data-act="projectsDismiss" data-arg="${esc(p.id)}">Dismiss</button>
    ${samples.length ? `<div class="set-proposal-samples set-muted">${esc(samples.join(' · '))}</div>` : ''}
  </div>`;
}

function proposalsBlock(pp, hasProjects) {
  const props = Array.isArray(pp?.proposals) ? pp.proposals : [];
  if (pp?.running || pp?.busy) return '<div class="set-text">Looking for projects in your recent conversations. This takes a few seconds.</div>';
  // A failed accept leaves the proposal in place (only 409/404 remove it), so
  // this line can appear alongside a still-populated suggested list; only
  // offer the Try again button when there is nothing left to accept from.
  const acceptFailedLine = pp?.error === 'accept_failed'
    ? `<div class="set-text">Could not create that project. Try again.${props.length ? '' : ' <button class="set-btn" data-act="projectsDiscover">Try again</button>'}</div>`
    : '';
  // A failed dismiss puts the proposal back into the list (see
  // live/settings.js projectsDismiss), so this always appears with the
  // suggested list still showing that proposal; no button, it just explains.
  const dismissFailedLine = pp?.error === 'dismiss_failed'
    ? '<div class="set-text set-muted">Could not dismiss that suggestion. It is still here.</div>'
    : '';
  if (props.length) {
    return acceptFailedLine + dismissFailedLine + `<div class="set-row-head">Suggested projects</div>
      <div class="set-text set-muted">Found by the local title model from your recent conversations. Nothing is filed until you accept.</div>
      ${map(props, proposalRowHtml)}`;
  }
  if (acceptFailedLine) return acceptFailedLine;
  if (dismissFailedLine) return dismissFailedLine;
  if (pp?.error === 'model_failed') {
    return `<div class="set-text">The local model did not answer, so no suggestions yet. <button class="set-btn" data-act="projectsDiscover">Try again</button></div>`;
  }
  // backend/project_discovery.py refuses to guess from a thin history. Without
  // this branch the person just sees "Find projects" again and clicks forever.
  if (pp?.error === 'too_few_threads') {
    return '<div class="set-text set-muted">Not enough recent conversations to suggest projects yet (12 or more in the last 90 days). Create one from a conversation’s menu.</div>';
  }
  if (pp?.error === 'no_local_model') {
    return '<div class="set-text set-muted">Suggestions need a local title model. Create projects by hand below.</div>';
  }
  if (!hasProjects) {
    return `<div class="set-text">No projects yet. <button class="set-btn" data-act="projectsDiscover">Find projects</button> in your recent conversations, or create one from a conversation's menu.</div>`;
  }
  return '';
}

const MOVE_LIST_CAP = 150;

function editPanel(s, isNew) {
  const err = s.projEditError ? `<div class="set-text set-muted">${esc(s.projEditError)}</div>` : '';
  return `<div class="set-proj-panel">
    <input class="set-proj-input" data-model="projEditName" data-focus="projEditName" placeholder="Name" value="${esc(s.projEditName || '')}" autocomplete="off">
    <input class="set-proj-input" data-model="projEditHints" data-focus="projEditHints" placeholder="Auto-sort hints, comma separated" value="${esc(s.projEditHints || '')}" autocomplete="off">
    <div class="set-text set-muted">Hints tell the auto-sorter what belongs here. New conversations that match are filed into it.</div>
    ${err}
    <div class="set-proj-actions"><button class="set-btn primary" data-act="projectEditSave">${isNew ? 'Create' : 'Save'}</button><button class="set-btn" data-act="projectEditCancel">Cancel</button></div>
  </div>`;
}

function mergePanel(s, p, list) {
  const others = list.filter((q) => q.id !== p.id && !q.archived);
  return `<div class="set-proj-panel">
    <div class="set-text">Merge <b>${esc(p.name)}</b> into:</div>
    <div class="set-proj-chips">${map(others, (q) => `<button class="set-btn" data-act="projectMerge" data-arg="${esc(p.id)}>${esc(q.id)}">${esc(q.name)}</button>`)}</div>
    <div class="set-text set-muted">Its conversations and hints move over and this project is removed.</div>
    <div class="set-proj-actions"><button class="set-btn" data-act="projectMergeCancel">Cancel</button></div>
  </div>`;
}

// Rows the Threads panel shows for `from` (a project id or 'unfiled'): live
// threads only, newest first, filtered by projMoveFilter, capped. Shared with
// the Select-shown action so the checkbox list and the action never disagree.
export function projectMoveRows(s, from) {
  const list = s.live?.projects || [];
  const sessions = Array.isArray(s.live?.chat?.sessions) ? s.live.chat.sessions : [];
  const unfiled = from === 'unfiled';
  const q = String(s.projMoveFilter || '').trim().toLowerCase();
  const inFrom = sessions
    .filter((x) => x && x.id && !x.archived && (unfiled ? !list.some((p) => p.id === x.folder) : x.folder === from))
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const matched = q ? inFrom.filter((x) => String(x.name || '').toLowerCase().includes(q)) : inFrom;
  return { matched, shown: matched.slice(0, MOVE_LIST_CAP) };
}

function movePanel(s, from, list) {
  const unfiled = from === 'unfiled';
  const { matched, shown } = projectMoveRows(s, from);
  const sel = new Set(s.live?.projSel || []);
  const n = sel.size;
  const targets = list.filter((p) => !p.archived && p.id !== from);
  const note = matched.length > shown.length ? `<div class="set-text set-muted">Showing ${shown.length} of ${matched.length}. Filter to narrow.</div>` : '';
  return `<div class="set-proj-panel">
    <input class="set-proj-input" data-model="projMoveFilter" data-focus="projMoveFilter" placeholder="Filter conversations" value="${esc(s.projMoveFilter || '')}" autocomplete="off">
    <div class="set-proj-actions"><button class="set-btn" data-act="projectMoveSelectAll">${shown.length && shown.every((x) => sel.has(x.id)) ? 'Clear shown' : 'Select shown'}</button><span class="set-muted">${n} selected</span></div>
    ${note}
    <div class="set-thread-list">${shown.length ? map(shown, (x) => `<div class="set-thread-row${sel.has(x.id) ? ' on' : ''}" data-act="projectMoveToggle" data-arg="${esc(x.id)}"><span class="ck">${sel.has(x.id) ? '☑' : '☐'}</span><span class="nm">${esc(x.name || 'Untitled')}</span></div>`) : '<div class="set-text set-muted">No conversations here.</div>'}</div>
    ${n ? `<div class="set-text">Move ${n} to:</div><div class="set-proj-chips">${map(targets, (p) => `<button class="set-btn" data-act="projectBulkMove" data-arg="${esc(p.id)}">${esc(p.name)}</button>`)}${unfiled ? '' : '<button class="set-btn" data-act="projectBulkMove" data-arg="none">Unfiled</button>'}</div>` : ''}
    <div class="set-proj-actions"><button class="set-btn" data-act="projectMoveClose">Done</button></div>
  </div>`;
}

export function projectsSettingsHtml(s) {
  const list = s.live?.projects;
  if (!Array.isArray(list)) return '<div class="set-text set-live-empty">Projects haven’t loaded yet.</div>';
  const act = list.filter((p) => !p.archived).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const arch = list.filter((p) => p.archived).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const row = (p) => {
    const a = (name, label, cls = '') => `<button class="set-btn${cls}" data-act="${name}" data-arg="${esc(p.id)}">${label}</button>`;
    const panel = s.projEditId === p.id ? editPanel(s, false)
      : s.projMergeId === p.id ? mergePanel(s, p, list)
      : s.projMoveId === p.id ? movePanel(s, p.id, list) : '';
    return `<div class="set-proj-block"><div class="set-proj-row"><span class="nm">${esc(p.name)}</span>`
      + a('projectEditOpen', 'Edit') + a('projectMoveOpen', 'Threads')
      + (p.archived ? '' : a('projectMergeOpen', 'Merge'))
      + (p.archived ? a('unarchiveProject', 'Unarchive') : a('archiveProject', 'Archive'))
      + a('deleteProject', 'Delete', ' danger') + `</div>${panel}</div>`;
  };
  const unfiledRow = `<div class="set-proj-block"><div class="set-proj-row"><span class="nm set-muted">Unfiled</span><button class="set-btn" data-act="projectMoveOpen" data-arg="unfiled">Threads</button></div>${s.projMoveId === 'unfiled' ? movePanel(s, 'unfiled', list) : ''}</div>`;
  const head = `<div class="set-row-head">Projects <button class="set-btn primary" style="margin-left:8px" data-act="projectEditOpen" data-arg="new">+ New</button></div>`;
  return proposalsBlock(s.live?.projectProposals, act.length + arch.length > 0)
    + head + (s.projEditId === 'new' ? editPanel(s, true) : '')
    + map(act, row) + unfiledRow
    + (arch.length ? `<div class="set-row-head" style="margin-top:10px">Archived</div>${map(arch, row)}` : '');
}
