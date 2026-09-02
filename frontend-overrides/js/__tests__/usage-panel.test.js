import { test } from 'node:test';
import assert from 'node:assert';
import { usagePanelHtml } from '../redesign/usage-panel.js';

const daily = [
  { date: '2026-08-30', totalTokens: 1000, input: 800, output: 200, totalCost: 0.5, missingCostEntries: 0 },
  { date: '2026-08-31', totalTokens: 4000, input: 3000, output: 1000, totalCost: 2.0, missingCostEntries: 0 },
];

test('renders one bar per day scaled to the max', () => {
  const html = usagePanelHtml({ days: 7, daily, totals: { input: 3800, output: 1200, totalTokens: 5000, totalCost: 2.5, missingCostEntries: 0 }, costed: true, error: null });
  assert.equal((html.match(/class="usage-bar"/g) || []).length, 2);
  assert.ok(html.includes('height:25%'));
  assert.ok(html.includes('height:100%'));
  assert.ok(html.includes('$2.50'));
  assert.ok(html.includes('data-arg="30"'));
});

test('hides dollars and explains when uncosted', () => {
  const html = usagePanelHtml({ days: 30, daily, totals: { input: 1, output: 1, totalTokens: 2, totalCost: 9, missingCostEntries: 12 }, costed: false, error: null });
  assert.ok(!html.includes('$9'));
  assert.ok(html.includes('not available for subscription models'));
  assert.ok(html.includes('12 uncosted'));
});

test('error state is honest and offers retry', () => {
  const html = usagePanelHtml({ days: 7, daily: [], totals: null, costed: false, error: 'gateway_error' });
  assert.ok(html.includes('Usage could not be loaded'));
  assert.ok(html.includes('data-act="usageRetry"'));
});

test('no em dashes in copy', () => {
  const html = usagePanelHtml({ days: 7, daily, totals: { input: 1, output: 1, totalTokens: 2, totalCost: 0, missingCostEntries: 0 }, costed: false, error: null });
  assert.ok(!html.includes('—'));
});
