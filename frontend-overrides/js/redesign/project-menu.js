// frontend-overrides/js/redesign/project-menu.js
// Pure helpers for the "Move to project" menu and the project/parent labels
// shown in the chat header (spec 6.2, 7.6). No DOM; `esc` is injected.

export const MOVE_NEW = 'new';
export const MOVE_NONE = '';

export function moveArg(sessionId, target) {
  return `${sessionId}|${target == null ? '' : target}`;
}

export function parseMoveArg(arg) {
  const s = String(arg || '');
  const i = s.indexOf('|');
  if (i === -1) return { id: s, target: MOVE_NONE };
  return { id: s.slice(0, i), target: s.slice(i + 1) };
}

function active(projects) {
  return (Array.isArray(projects) ? projects : [])
    .filter((p) => p && p.id && !p.archived)
    .slice()
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
}

export function moveMenuItems(sessionId, projects, currentFolder) {
  const items = [];
  if (currentFolder) items.push({ act: 'moveToProject', arg: moveArg(sessionId, MOVE_NONE), label: 'No project', on: false, kind: 'none' });
  for (const p of active(projects)) {
    items.push({ act: 'moveToProject', arg: moveArg(sessionId, p.id), label: p.name || 'Project', on: p.id === currentFolder, kind: 'project' });
  }
  items.push({ act: 'moveToProject', arg: moveArg(sessionId, MOVE_NEW), label: 'New project…', on: false, kind: 'new' });
  return items;
}

export function projectName(projects, pid) {
  if (!pid || !Array.isArray(projects)) return '';
  const p = projects.find((x) => x && x.id === pid);
  if (!p) return '';
  return p.archived ? `${p.name || 'Project'} (archived)` : (p.name || 'Project');
}

export function parentTitle(sessions, parentId) {
  if (!parentId || !Array.isArray(sessions)) return null;
  const s = sessions.find((x) => x && x.id === parentId);
  return s ? (s.name || 'New chat') : null;
}

export function moveMenuHtml(sessionId, projects, currentFolder, esc) {
  const items = moveMenuItems(sessionId, projects, currentFolder);
  return `<div class="cm-sub-head">Move to</div>`
    + items.map((it) => `<button class="cm-item cm-move${it.on ? ' on' : ''}${it.kind === 'new' ? ' cm-new' : ''}" data-act="${it.act}" data-arg="${esc(it.arg)}" role="menuitem">`
      + `<span class="cm-ic">${it.on ? '✓' : ''}</span>${esc(it.label)}</button>`).join('');
}
