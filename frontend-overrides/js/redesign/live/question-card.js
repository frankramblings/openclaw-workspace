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

// renderQuestionCard builds the DOM. Guarded so importing the pure helpers in a
// DOM-less test does not require document.
export function renderQuestionCard(model, opts = {}) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const { onAnswer, locked = false, choice = '' } = opts;
  const card = document.createElement('div');
  card.className = 'question-card' + (locked ? ' question-card--locked' : '');

  if (locked) {
    const receipt = document.createElement('div');
    receipt.className = 'question-card__receipt';
    receipt.textContent = choice ? `You chose: ${choice}` : 'Answered';
    card.appendChild(receipt);
    return card;
  }

  const selections = model.questions.map((q) => (q.multiSelect ? [] : null));
  const commit = () => {
    const answer = composeAnswer(model.questions, selections.map((s) => (s == null ? '' : s)));
    card.classList.add('question-card--locked');
    if (typeof onAnswer === 'function') onAnswer(answer, selections.slice());
  };
  const allResolved = () => selections.every((s, i) =>
    model.questions[i].multiSelect ? (Array.isArray(s) && s.length) : (s != null && s !== ''));

  model.questions.forEach((q, qi) => {
    const sec = document.createElement('div');
    sec.className = 'question-card__q';
    const prompt = document.createElement('div');
    prompt.className = 'question-card__prompt';
    prompt.textContent = q.question || q.header;
    sec.appendChild(prompt);

    q.options.forEach((o) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'question-card__opt';
      btn.textContent = o.label;
      if (o.description) btn.title = o.description;
      btn.addEventListener('click', () => {
        if (q.multiSelect) {
          const arr = selections[qi];
          const at = arr.indexOf(o.label);
          if (at >= 0) { arr.splice(at, 1); btn.classList.remove('is-sel'); }
          else { arr.push(o.label); btn.classList.add('is-sel'); }
        } else {
          selections[qi] = o.label;
          sec.querySelectorAll('.question-card__opt').forEach((b) => b.classList.remove('is-sel'));
          btn.classList.add('is-sel');
          // single question + single-select => instant send
          if (model.questions.length === 1) commit();
        }
      });
      sec.appendChild(btn);
    });

    // "Other" free-text escape
    const other = document.createElement('input');
    other.type = 'text';
    other.className = 'question-card__other';
    other.placeholder = 'Other…';
    other.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && other.value.trim()) {
        selections[qi] = other.value.trim();
        if (!q.multiSelect && model.questions.length === 1) commit();
      }
    });
    sec.appendChild(other);
    card.appendChild(sec);
  });

  // Send button: shown for multi-select or multi-question cards (deliberate commit)
  const needsButton = model.questions.length > 1 || model.questions.some((q) => q.multiSelect);
  if (needsButton) {
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'question-card__send';
    send.textContent = 'Send';
    send.addEventListener('click', () => { if (allResolved()) commit(); });
    card.appendChild(send);
  }
  return card;
}
