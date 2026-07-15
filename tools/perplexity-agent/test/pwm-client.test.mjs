import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPwmClient } from '../src/pwm-client.mjs';

test('posts OpenAI-compatible chat completions to pwm', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: 'FINAL: ok' } }] };
      },
    };
  };
  const client = createPwmClient({ baseUrl: 'http://pwm.test/v1', apiKey: 'test-key', fetchImpl });
  const out = await client.complete([{ role: 'user', content: 'hi' }], { model: 'perplexity-auto' });
  assert.equal(out.text, 'FINAL: ok');
  assert.equal(calls[0].url, 'http://pwm.test/v1/chat/completions');
  assert.equal(JSON.parse(calls[0].init.body).model, 'perplexity-auto');
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-key');
});

test('surfaces provider errors', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, async text() { return 'broken'; } });
  const client = createPwmClient({ baseUrl: 'http://pwm.test/v1', fetchImpl });
  await assert.rejects(
    () => client.complete([{ role: 'user', content: 'hi' }], { model: 'perplexity-auto' }),
    /pwm request failed: 500 broken/,
  );
});
