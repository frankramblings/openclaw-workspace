import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuestionCard, composeAnswer } from '../redesign/live/question-card.js';

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
