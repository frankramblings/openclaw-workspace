import assert from 'node:assert/strict';
import { createPwmClient } from '../src/pwm-client.mjs';

const client = createPwmClient();
const result = await client.complete([{ role: 'user', content: 'Reply exactly: PPLX_AGENT_OK' }], {
  model: process.env.PPLX_AGENT_MODEL || 'perplexity-auto',
});
assert.match(result.text, /PPLX_AGENT_OK/i);
console.log('PPLX_AGENT_OK');
