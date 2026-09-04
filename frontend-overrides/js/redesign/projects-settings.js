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
  if (pp?.error === 'no_local_model') {
    return '<div class="set-text set-muted">Suggestions need a local title model. Create projects by hand below.</div>';
  }
  if (!hasProjects) {
    return `<div class="set-text">No projects yet. <button class="set-btn" data-act="projectsDiscover">Find projects</button> in your recent conversations, or create one from a conversation's menu.</div>`;
  }
  return '';
}

export function projectsSettingsHtml(s) {
  const list = s.live?.projects;
  if (!Array.isArray(list)) return '<div class="set-text set-live-empty">Projects haven’t loaded yet.</div>';
  const act = list.filter((p) => !p.archived).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const arch = list.filter((p) => p.archived).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const row = (p) => `<div class="set-proj-row"><span class="nm">${esc(p.name)}</span>`
    + `<button class="set-btn" data-act="renameProject" data-arg="${esc(p.id)}">Rename</button>`
    + (p.archived
      ? `<button class="set-btn" data-act="unarchiveProject" data-arg="${esc(p.id)}">Unarchive</button>`
      : `<button class="set-btn" data-act="archiveProject" data-arg="${esc(p.id)}">Archive</button>`)
    + `<button class="set-btn danger" data-act="deleteProject" data-arg="${esc(p.id)}">Delete</button></div>`;
  return proposalsBlock(s.live?.projectProposals, act.length + arch.length > 0)
    + (act.length ? `<div class="set-row-head">Projects</div>${map(act, row)}` : '')
    + (arch.length ? `<div class="set-row-head" style="margin-top:10px">Archived</div>${map(arch, row)}` : '');
}
