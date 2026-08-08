// Renders an AskUserQuestion tool call as a tappable card in the webchat.
// Sibling of promise-warning.js — DOM-light so the __tests__ stubs can import
// the pure helpers (parse/compose) without a DOM.

export function parseQuestionCard(input) {
  if (!input || !Array.isArray(input.questions) || !input.questions.length) return null;
  const questions = input.questions.map((q) => ({
    question: String(q.question || ''),
    header: String(q.header || ''),
    multiSelect: !!q.multiSelect,
    options: Array.isArray(q.options)
      ? q.options.map((o) => ({ label: String(o.label || ''), description: String(o.description || '') }))
      : [],
  }));
  return { questions };
}

export function composeAnswer(questions, selections) {
  const parts = (questions || []).map((q, i) => {
    const sel = selections[i];
    const ans = Array.isArray(sel) ? sel.join(', ') : String(sel == null ? '' : sel);
    return { header: q.header, ans };
  });
  if (parts.length === 1) return parts[0].ans;
  return parts.map((p) => `${p.header}: ${p.ans}`).join('\n');
}

// questionCardHtml builds the card as an HTML string, matching the surfaces'
// idiom (HTML-string render + data-act delegation in app.js) rather than DOM
// node construction. Kept dependency-free — `esc` is passed in by the caller
// (surfaces.js / mobile-surfaces.js) so this module stays DOM-free and the
// node:test import above works without a document.
export function questionCardHtml(model, esc, opts = {}) {
  const { locked = false, choice = '', selections = [], toolId = '' } = opts;

  if (locked) {
    const receipt = choice ? `You chose: ${esc(choice)}` : 'Answered';
    return `<div class="question-card question-card--locked"><div class="question-card__receipt">${receipt}</div></div>`;
  }

  const qHtml = model.questions.map((q, qi) => {
    const sel = selections[qi];
    const prompt = esc(q.question || q.header);
    const optsHtml = q.options.map((o) => {
      const arg = esc(JSON.stringify({ toolId, qi, label: o.label }));
      const title = o.description ? ` title="${esc(o.description)}"` : '';
      if (q.multiSelect) {
        const isSel = Array.isArray(sel) && sel.includes(o.label);
        return `<button type="button" class="question-card__opt${isSel ? ' is-sel' : ''}" data-act="qcToggle" data-arg="${arg}"${title}>${esc(o.label)}</button>`;
      }
      const isSel = sel === o.label;
      return `<button type="button" class="question-card__opt${isSel ? ' is-sel' : ''}" data-act="qcPick" data-arg="${arg}"${title}>${esc(o.label)}</button>`;
    }).join('');
    const otherArg = esc(JSON.stringify({ toolId, qi }));
    const otherHtml = `<div class="question-card__other-row"><input type="text" class="question-card__other" placeholder="Other…"><button type="button" class="question-card__other-submit" data-act="qcOther" data-arg="${otherArg}">Submit</button></div>`;
    return `<div class="question-card__q"><div class="question-card__prompt">${prompt}</div>${optsHtml}${otherHtml}</div>`;
  }).join('');

  const needsButton = model.questions.length > 1 || model.questions.some((q) => q.multiSelect);
  const sendHtml = needsButton
    ? `<button type="button" class="question-card__send" data-act="qcSend" data-arg="${esc(JSON.stringify({ toolId }))}">Send</button>`
    : '';

  return `<div class="question-card">${qHtml}${sendHtml}</div>`;
}
