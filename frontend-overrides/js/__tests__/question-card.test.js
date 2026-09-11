import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuestionCard, composeAnswer, questionCardHtml, selectionLists } from '../redesign/live/question-card.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

test('parseQuestionCard returns null without questions', () => {
  assert.equal(parseQuestionCard({}), null);
  assert.equal(parseQuestionCard(null), null);
});

test('parseQuestionCard normalizes questions', () => {
  const m = parseQuestionCard({ questions: [
    { question: 'Pause it?', header: 'IPTV', multiSelect: false,
      options: [{ label: 'Yes', description: 'stop the check' }, { label: 'No', description: '' }] },
  ]});
  assert.equal(m.questions.length, 1);
  assert.equal(m.questions[0].header, 'IPTV');
  assert.equal(m.questions[0].multiSelect, false);
  assert.equal(m.questions[0].options[0].label, 'Yes');
});

test('composeAnswer single question single-select = the label', () => {
  const qs = [{ header: 'IPTV', multiSelect: false, options: [] }];
  assert.equal(composeAnswer(qs, ['Yes']), 'Yes');
});

test('composeAnswer multi-select joins labels', () => {
  const qs = [{ header: 'Jobs', multiSelect: true, options: [] }];
  assert.equal(composeAnswer(qs, [['IPTV', 'Cortex']]), 'IPTV, Cortex');
});

test('composeAnswer multiple questions uses header lines', () => {
  const qs = [
    { header: 'IPTV', multiSelect: false, options: [] },
    { header: 'Watcher', multiSelect: false, options: [] },
  ];
  assert.equal(composeAnswer(qs, ['Yes', 'No']), 'IPTV: Yes\nWatcher: No');
});

test('questionCardHtml locked renders the choice and no qcPick button', () => {
  const model = { questions: [{ question: 'Pause it?', header: 'IPTV', multiSelect: false, options: [{ label: 'Yes' }] }] };
  const html = questionCardHtml(model, esc, { locked: true, choice: 'Yes' });
  assert.match(html, /question-card--locked/);
  assert.match(html, /You chose: Yes/);
  assert.doesNotMatch(html, /qcPick/);
});

test('questionCardHtml single-select live renders a qcPick button per option and an Other input', () => {
  const model = { questions: [{ question: 'Pause it?', header: 'IPTV', multiSelect: false,
    options: [{ label: 'Yes' }, { label: 'No' }] }] };
  const html = questionCardHtml(model, esc, { toolId: 't1' });
  assert.match(html, /data-act="qcPick"/);
  const picks = html.match(/data-act="qcPick"/g) || [];
  assert.equal(picks.length, 2);
  assert.match(html, /question-card__other/);
  assert.doesNotMatch(html, /question-card__send/);
});

test('questionCardHtml multi-select renders qcToggle + a qcSend button', () => {
  const model = { questions: [{ question: 'Which jobs?', header: 'Jobs', multiSelect: true,
    options: [{ label: 'IPTV' }, { label: 'Cortex' }] }] };
  const html = questionCardHtml(model, esc, { toolId: 't1', selections: [[]] });
  assert.match(html, /data-act="qcToggle"/);
  assert.match(html, /data-act="qcSend"/);
});

test('questionCardHtml selected multi-select option carries the selected class', () => {
  const model = { questions: [{ question: 'Which jobs?', header: 'Jobs', multiSelect: true,
    options: [{ label: 'IPTV' }, { label: 'Cortex' }] }] };
  const html = questionCardHtml(model, esc, { toolId: 't1', selections: [['IPTV']] });
  assert.match(html, /question-card__opt is-sel" data-act="qcToggle" data-arg="[^"]*IPTV/);
});

test('questionCardHtml disables Send until every question has a selection', () => {
  const model = { questions: [
    { question: 'Where?', header: 'Location', multiSelect: false, options: [{ label: 'Dover' }] },
    { question: 'What food?', header: 'Tastes', multiSelect: true, options: [{ label: 'Thai' }] },
  ]};
  // Nothing picked: Send must not be able to submit an empty answer (this is
  // what wrote `{"choice": "Location: \nTastes: "}` into the sidecar).
  const empty = questionCardHtml(model, esc, { toolId: 't1', selections: [] });
  assert.match(empty, /question-card__send[^"]*is-disabled/);
  assert.match(empty, /disabled/);
  // Partially answered is still not submittable.
  const partial = questionCardHtml(model, esc, { toolId: 't1', selections: ['Dover', []] });
  assert.match(partial, /question-card__send[^"]*is-disabled/);
  // Fully answered: live Send.
  const full = questionCardHtml(model, esc, { toolId: 't1', selections: ['Dover', ['Thai']] });
  assert.doesNotMatch(full, /is-disabled/);
});

test('selectionLists normalizes card selections into per-question label arrays', () => {
  const qs = [{ multiSelect: false }, { multiSelect: true }, { multiSelect: false }];
  assert.deepEqual(selectionLists(qs, ['Dover', ['Thai', 'Sushi'], null]),
    [['Dover'], ['Thai', 'Sushi'], []]);
  assert.deepEqual(selectionLists(qs, []), [[], [], []]);
});
