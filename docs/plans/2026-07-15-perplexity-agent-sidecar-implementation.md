# Perplexity Agent Sidecar Implementation Plan

> **For implementer:** Use TDD throughout. Write failing test first. Watch it fail. Then implement.

**Goal:** Build a local research-only Perplexity agent sidecar that owns a small tool loop and exposes it through both a CLI and an MCP server.

**Architecture:** The sidecar is a self-contained Node.js package under `tools/perplexity-agent/`. It talks to the existing local `pwm` OpenAI-compatible proxy for model completions, parses text-form tool requests from the model, executes only allowlisted research tools, and returns a final answer plus a compact trace. No OpenClaw gateway runtime changes in v0.

**Tech Stack:** Node.js ES modules, built-in `node:test`, built-in `fetch`, `@modelcontextprotocol/sdk` for the MCP stdio server.

---

## Scope Rules

- v0 is research-only: `web_search` and `web_fetch`.
- No shell tools, filesystem writes, email, posting, or account actions.
- No changes to OpenClaw gateway runtime or existing model routing.
- Keep all implementation under `tools/perplexity-agent/`.
- Each task should be committed separately after its tests pass.

## Task 1: Scaffold Package

**Files:**
- Create: `tools/perplexity-agent/package.json`
- Create: `tools/perplexity-agent/src/index.mjs`
- Create: `tools/perplexity-agent/test/smoke.test.mjs`

**Step 1: Write the failing test**

```js
// tools/perplexity-agent/test/smoke.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { version } from '../src/index.mjs';

test('exports a package version marker', () => {
  assert.equal(version, '0.1.0');
});
```

**Step 2: Run test — confirm it fails**

Command:

```bash
cd tools/perplexity-agent && npm test -- test/smoke.test.mjs
```

Expected: FAIL because `package.json` and/or `src/index.mjs` do not exist.

**Step 3: Write minimal implementation**

```json
// tools/perplexity-agent/package.json
{
  "name": "perplexity-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "pplx-agent": "./src/cli.mjs",
    "pplx-agent-mcp": "./src/server.mjs"
  },
  "scripts": {
    "test": "node --test"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.17.0"
  }
}
```

```js
// tools/perplexity-agent/src/index.mjs
export const version = '0.1.0';
```

**Step 4: Run test — confirm it passes**

Command:

```bash
cd tools/perplexity-agent && npm test -- test/smoke.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tools/perplexity-agent/package.json tools/perplexity-agent/src/index.mjs tools/perplexity-agent/test/smoke.test.mjs
git commit -m "feat(pplx-agent): scaffold sidecar package"
```

## Task 2: Parse Text Tool Protocol

**Files:**
- Create: `tools/perplexity-agent/src/protocol.mjs`
- Create: `tools/perplexity-agent/test/protocol.test.mjs`

**Step 1: Write the failing test**

```js
// tools/perplexity-agent/test/protocol.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAssistantOutput } from '../src/protocol.mjs';

test('parses a final answer', () => {
  assert.deepEqual(parseAssistantOutput('FINAL: done'), {
    type: 'final',
    answer: 'done',
  });
});

test('treats plain text as final answer', () => {
  assert.deepEqual(parseAssistantOutput('No tools needed.'), {
    type: 'final',
    answer: 'No tools needed.',
  });
});

test('parses a tool call with JSON input', () => {
  assert.deepEqual(parseAssistantOutput('THOUGHT: search first\nTOOL web_search {"query":"OpenClaw"}'), {
    type: 'tool',
    tool: 'web_search',
    input: { query: 'OpenClaw' },
    thought: 'search first',
  });
});

test('returns invalid_tool_json for malformed JSON', () => {
  const parsed = parseAssistantOutput('TOOL web_search {"query":');
  assert.equal(parsed.type, 'invalid_tool_json');
  assert.equal(parsed.tool, 'web_search');
  assert.match(parsed.error, /JSON/);
});

test('rejects tool names outside the simple identifier format', () => {
  assert.deepEqual(parseAssistantOutput('TOOL ../../shell {"cmd":"ls"}'), {
    type: 'final',
    answer: 'TOOL ../../shell {"cmd":"ls"}',
  });
});
```

**Step 2: Run test — confirm it fails**

Command:

```bash
cd tools/perplexity-agent && npm test -- test/protocol.test.mjs
```

Expected: FAIL because `protocol.mjs` does not exist.

**Step 3: Write minimal implementation**

```js
// tools/perplexity-agent/src/protocol.mjs
const TOOL_RE = /(?:^|\n)TOOL\s+([A-Za-z][A-Za-z0-9_-]*)\s+(\{[\s\S]*\})\s*$/;
const THOUGHT_RE = /(?:^|\n)THOUGHT:\s*([^\n]+)/;

export function parseAssistantOutput(text) {
  const raw = String(text || '').trim();
  if (raw.startsWith('FINAL:')) {
    return { type: 'final', answer: raw.slice('FINAL:'.length).trim() };
  }
  const match = raw.match(TOOL_RE);
  if (!match) {
    return { type: 'final', answer: raw };
  }
  const [, tool, jsonText] = match;
  try {
    const input = JSON.parse(jsonText);
    const thought = raw.match(THOUGHT_RE)?.[1]?.trim() || '';
    return { type: 'tool', tool, input, thought };
  } catch (err) {
    return { type: 'invalid_tool_json', tool, raw: jsonText, error: String(err?.message || err) };
  }
}

export function formatToolResult(tool, result) {
  return `TOOL_RESULT ${tool} ${JSON.stringify(result)}`;
}
```

**Step 4: Run test — confirm it passes**

Command:

```bash
cd tools/perplexity-agent && npm test -- test/protocol.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tools/perplexity-agent/src/protocol.mjs tools/perplexity-agent/test/protocol.test.mjs
git commit -m "feat(pplx-agent): parse text tool protocol"
```

## Task 3: Add Result Limits

**Files:**
- Create: `tools/perplexity-agent/src/limits.mjs`
- Create: `tools/perplexity-agent/test/limits.test.mjs`

**Step 1: Write the failing test**

```js
// tools/perplexity-agent/test/limits.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactToolResult } from '../src/limits.mjs';

test('leaves small string results untouched', () => {
  assert.equal(compactToolResult('short', 20), 'short');
});

test('trims long string results with a truncation note', () => {
  const out = compactToolResult('abcdefghijklmnopqrstuvwxyz', 10);
  assert.equal(out, 'abcdefghij\n[truncated 16 chars]');
});

test('serializes and trims object results deterministically', () => {
  const out = compactToolResult({ b: 2, a: 1 }, 100);
  assert.equal(out, '{\n  "b": 2,\n  "a": 1\n}');
});
```

**Step 2: Run test — confirm it fails**

Command:

```bash
cd tools/perplexity-agent && npm test -- test/limits.test.mjs
```

Expected: FAIL because `limits.mjs` does not exist.

**Step 3: Write minimal implementation**

```js
// tools/perplexity-agent/src/limits.mjs
export function compactToolResult(value, maxChars = 6000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}
```

**Step 4: Run test — confirm it passes**

Command:

```bash
cd tools/perplexity-agent && npm test -- test/limits.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tools/perplexity-agent/src/limits.mjs tools/perplexity-agent/test/limits.test.mjs
git commit -m "feat(pplx-agent): bound tool result size"
```

## Task 4: Build the Agent Loop With Fake Model and Tools

**Files:**
- Create: `tools/perplexity-agent/src/runtime.mjs`
- Create: `tools/perplexity-agent/test/runtime.test.mjs`

**Step 1: Write the failing test**

```js
// tools/perplexity-agent/test/runtime.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/runtime.mjs';

function fakeClient(outputs) {
  let i = 0;
  return {
    async complete(messages) {
      return { text: outputs[i++] || 'FINAL: fallback', messagesSeen: messages.length };
    },
  };
}

test('returns final answer without tools', async () => {
  const result = await runAgent({
    prompt: 'hi',
    modelClient: fakeClient(['FINAL: hello']),
    tools: {},
  });
  assert.equal(result.answer, 'hello');
  assert.equal(result.rounds, 1);
  assert.deepEqual(result.trace, []);
});

test('runs an allowlisted tool and continues', async () => {
  const result = await runAgent({
    prompt: 'look this up',
    modelClient: fakeClient([
      'THOUGHT: need search\nTOOL web_search {"query":"OpenClaw"}',
      'FINAL: found it',
    ]),
    tools: {
      web_search: async (input) => ({ results: [{ title: input.query, url: 'https://example.com' }] }),
    },
  });
  assert.equal(result.answer, 'found it');
  assert.equal(result.rounds, 2);
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].tool, 'web_search');
});

test('stops on unknown tools', async () => {
  const result = await runAgent({
    prompt: 'do bad thing',
    modelClient: fakeClient(['TOOL shell {"cmd":"rm -rf /"}']),
    tools: {},
  });
  assert.equal(result.stopped_reason, 'unknown_tool');
  assert.match(result.answer, /Unknown tool/);
});

test('stops at max rounds', async () => {
  const result = await runAgent({
    prompt: 'loop',
    modelClient: fakeClient([
      'TOOL web_search {"query":"1"}',
      'TOOL web_search {"query":"2"}',
    ]),
    tools: { web_search: async () => 'ok' },
    maxRounds: 2,
  });
  assert.equal(result.stopped_reason, 'max_rounds');
  assert.equal(result.trace.length, 2);
});
```

**Step 2: Run test — confirm it fails**

Command:

```bash
cd tools/perplexity-agent && npm test -- test/runtime.test.mjs
```

Expected: FAIL because `runtime.mjs` does not exist.

**Step 3: Write minimal implementation**

```js
// tools/perplexity-agent/src/runtime.mjs
import { compactToolResult } from './limits.mjs';
import { formatToolResult, parseAssistantOutput } from './protocol.mjs';

const SYSTEM_PROMPT = `You are a research agent. Use tools only when needed.
To use a tool, end your message with exactly:
TOOL tool_name {"key":"value"}
When done, answer with:
FINAL: your answer`;

export async function runAgent({ prompt, modelClient, tools, model = 'perplexity-auto', maxRounds = 4 }) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: String(prompt || '') },
  ];
  const trace = [];
  let lastText = '';
  for (let round = 1; round <= maxRounds; round += 1) {
    const completion = await modelClient.complete(messages, { model });
    lastText = completion.text || '';
    const parsed = parseAssistantOutput(lastText);
    if (parsed.type === 'final') {
      return { answer: parsed.answer, model, rounds: round, trace };
    }
    if (parsed.type === 'invalid_tool_json') {
      messages.push({ role: 'assistant', content: lastText });
      messages.push({ role: 'user', content: formatToolResult(parsed.tool, { error: parsed.error }) });
      continue;
    }
    const fn = tools[parsed.tool];
    if (!fn) {
      return {
        answer: `Unknown tool requested: ${parsed.tool}`,
        model,
        rounds: round,
        trace,
        stopped_reason: 'unknown_tool',
      };
    }
    const output = await fn(parsed.input);
    const compact = compactToolResult(output);
    trace.push({ tool: parsed.tool, input: parsed.input, summary: compact.slice(0, 500) });
    messages.push({ role: 'assistant', content: lastText });
    messages.push({ role: 'user', content: formatToolResult(parsed.tool, compact) });
  }
  return { answer: lastText.trim(), model, rounds: maxRounds, trace, stopped_reason: 'max_rounds' };
}
```

**Step 4: Run test — confirm it passes**

Command:

```bash
cd tools/perplexity-agent && npm test -- test/runtime.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tools/perplexity-agent/src/runtime.mjs tools/perplexity-agent/test/runtime.test.mjs
git commit -m "feat(pplx-agent): add sidecar agent loop"
```

## Task 5: Add Perplexity PWM Client

**Files:**
- Create: `tools/perplexity-agent/src/pwm-client.mjs`
- Create: `tools/perplexity-agent/test/pwm-client.test.mjs`

**Step 1: Write the failing test**

```js
// tools/perplexity-agent/test/pwm-client.test.mjs
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
```

**Step 2: Run test — confirm it fails**

Command:

```bash
cd tools/perplexity-agent && npm test -- test/pwm-client.test.mjs
```

Expected: FAIL because `pwm-client.mjs` does not exist.

**Step 3: Write minimal implementation**

```js
// tools/perplexity-agent/src/pwm-client.mjs
export function createPwmClient({
  baseUrl = process.env.PPLX_AGENT_PWM_BASE_URL || 'http://127.0.0.1:18080/v1',
  apiKey = process.env.PPLX_AGENT_PWM_API_KEY || 'perplexity-local',
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation required');
  return {
    async complete(messages, { model = 'perplexity-auto' } = {}) {
      const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages, temperature: 0.2 }),
      });
      if (!res.ok) {
        throw new Error(`pwm request failed: ${res.status} ${await res.text()}`);
      }
      const data = await res.json();
      return { text: data?.choices?.[0]?.message?.content || '' };
    },
  };
}
```

**Step 4: Run test — confirm it passes**

Command:

```bash
cd tools/perplexity-agent && npm test -- test/pwm-client.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tools/perplexity-agent/src/pwm-client.mjs tools/perplexity-agent/test/pwm-client.test.mjs
git commit -m "feat(pplx-agent): call local pwm proxy"
```

## Task 6: Add Research Tools

**Files:**
- Create: `tools/perplexity-agent/src/research-tools.mjs`
- Create: `tools/perplexity-agent/test/research-tools.test.mjs`

**Step 1: Write the failing test**

```js
// tools/perplexity-agent/test/research-tools.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResearchTools, stripHtml } from '../src/research-tools.mjs';

test('stripHtml removes scripts, tags, and repeated whitespace', () => {
  assert.equal(stripHtml('<html><script>bad()</script><body><h1>Title</h1><p>Hello   world</p></body></html>'), 'Title Hello world');
});

test('web_fetch returns bounded readable text', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'text/html']]),
    async text() { return '<h1>Example</h1><p>Body text</p>'; },
  });
  const tools = createResearchTools({ fetchImpl, serpApiKey: 'unused' });
  const out = await tools.web_fetch({ url: 'https://example.com' });
  assert.equal(out.url, 'https://example.com');
  assert.match(out.text, /Example Body text/);
});

test('web_search maps SerpAPI organic results', async () => {
  const fetchImpl = async (url) => {
    assert.match(String(url), /serpapi\.com/);
    return {
      ok: true,
      status: 200,
      async json() {
        return { organic_results: [{ title: 'One', link: 'https://one.test', snippet: 'Snippet' }] };
      },
    };
  };
  const tools = createResearchTools({ fetchImpl, serpApiKey: 'key' });
  const out = await tools.web_search({ query: 'test' });
  assert.deepEqual(out.results, [{ title: 'One', url: 'https://one.test', snippet: 'Snippet' }]);
});

test('web_search requires a key', async () => {
  const tools = createResearchTools({ fetchImpl: async () => null, serpApiKey: '' });
  await assert.rejects(() => tools.web_search({ query: 'test' }), /SerpAPI key/);
});
```

**Step 2: Run test — confirm it fails**

Command:

```bash
cd tools/perplexity-agent && npm test -- test/research-tools.test.mjs
```

Expected: FAIL because `research-tools.mjs` does not exist.

**Step 3: Write minimal implementation**

```js
// tools/perplexity-agent/src/research-tools.mjs
export function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createResearchTools({ fetchImpl = globalThis.fetch, serpApiKey = process.env.SERPAPI_API_KEY || '' } = {}) {
  return {
    async web_fetch({ url }) {
      const target = new URL(url);
      if (!/^https?:$/.test(target.protocol)) throw new Error('web_fetch only supports http/https URLs');
      const res = await fetchImpl(target.href, { headers: { 'user-agent': 'perplexity-agent/0.1' } });
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const text = stripHtml(await res.text());
      return { url: target.href, text: text.slice(0, 12000) };
    },
    async web_search({ query, count = 5 }) {
      if (!serpApiKey) throw new Error('SerpAPI key required for web_search');
      const params = new URLSearchParams({
        engine: 'google',
        q: String(query || ''),
        num: String(Math.max(1, Math.min(Number(count) || 5, 10))),
        api_key: serpApiKey,
      });
      const res = await fetchImpl(`https://serpapi.com/search.json?${params.toString()}`);
      if (!res.ok) throw new Error(`search failed: ${res.status}`);
      const data = await res.json();
      return {
        results: (data.organic_results || []).filter((r) => r.link).slice(0, count).map((r) => ({
          title: r.title || r.link,
          url: r.link,
          snippet: r.snippet || '',
        })),
      };
    },
  };
}
```

**Step 4: Run test — confirm it passes**

Command:

```bash
cd tools/perplexity-agent && npm test -- test/research-tools.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tools/perplexity-agent/src/research-tools.mjs tools/perplexity-agent/test/research-tools.test.mjs
git commit -m "feat(pplx-agent): add research tools"
```

## Task 7: Add CLI

**Files:**
- Create: `tools/perplexity-agent/src/cli.mjs`
- Create: `tools/perplexity-agent/test/cli.test.mjs`
- Modify: `tools/perplexity-agent/src/index.mjs`

**Step 1: Write the failing test**

```js
// tools/perplexity-agent/test/cli.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs } from '../src/cli.mjs';

test('parses prompt and defaults', () => {
  assert.deepEqual(parseCliArgs(['research this']), {
    prompt: 'research this',
    model: 'perplexity-auto',
    maxRounds: 4,
    json: false,
  });
});

test('parses model, rounds, and json flag', () => {
  assert.deepEqual(parseCliArgs(['--model', 'claude-sonnet-4-6', '--max-rounds', '2', '--json', 'hi']), {
    prompt: 'hi',
    model: 'claude-sonnet-4-6',
    maxRounds: 2,
    json: true,
  });
});
```

**Step 2: Run test — confirm it fails**

Command:

```bash
cd tools/perplexity-agent && npm test -- test/cli.test.mjs
```

Expected: FAIL because `cli.mjs` does not exist.

**Step 3: Write minimal implementation**

```js
// tools/perplexity-agent/src/cli.mjs
#!/usr/bin/env node
import { createPwmClient } from './pwm-client.mjs';
import { createResearchTools } from './research-tools.mjs';
import { runAgent } from './runtime.mjs';

export function parseCliArgs(argv) {
  const args = [...argv];
  let model = 'perplexity-auto';
  let maxRounds = 4;
  let json = false;
  const parts = [];
  while (args.length) {
    const arg = args.shift();
    if (arg === '--model') model = args.shift() || model;
    else if (arg === '--max-rounds') maxRounds = Number(args.shift()) || maxRounds;
    else if (arg === '--json') json = true;
    else parts.push(arg);
  }
  return { prompt: parts.join(' ').trim(), model, maxRounds, json };
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (!opts.prompt) {
    console.error('Usage: pplx-agent [--model MODEL] [--max-rounds N] [--json] <prompt>');
    process.exit(2);
  }
  const result = await runAgent({
    prompt: opts.prompt,
    model: opts.model,
    maxRounds: opts.maxRounds,
    modelClient: createPwmClient(),
    tools: createResearchTools(),
  });
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result.answer);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.stack || err);
    process.exit(1);
  });
}
```

Update exports:

```js
// tools/perplexity-agent/src/index.mjs
export const version = '0.1.0';
export { runAgent } from './runtime.mjs';
export { createPwmClient } from './pwm-client.mjs';
export { createResearchTools } from './research-tools.mjs';
```

**Step 4: Run test — confirm it passes**

Command:

```bash
cd tools/perplexity-agent && npm test -- test/cli.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tools/perplexity-agent/src/cli.mjs tools/perplexity-agent/src/index.mjs tools/perplexity-agent/test/cli.test.mjs
git commit -m "feat(pplx-agent): add cli wrapper"
```

## Task 8: Add MCP Server

**Files:**
- Create: `tools/perplexity-agent/src/server.mjs`
- Create: `tools/perplexity-agent/test/server.test.mjs`

**Step 1: Write the failing test**

```js
// tools/perplexity-agent/test/server.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askSchema, normalizeAskInput } from '../src/server.mjs';

test('exports MCP ask schema', () => {
  assert.equal(askSchema.type, 'object');
  assert.equal(askSchema.properties.prompt.type, 'string');
  assert.equal(askSchema.required[0], 'prompt');
});

test('normalizes ask input defaults', () => {
  assert.deepEqual(normalizeAskInput({ prompt: 'hi' }), {
    prompt: 'hi',
    model: 'perplexity-auto',
    maxRounds: 4,
  });
});
```

**Step 2: Run test — confirm it fails**

Command:

```bash
cd tools/perplexity-agent && npm test -- test/server.test.mjs
```

Expected: FAIL because `server.mjs` does not exist.

**Step 3: Write minimal implementation**

```js
// tools/perplexity-agent/src/server.mjs
#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createPwmClient } from './pwm-client.mjs';
import { createResearchTools } from './research-tools.mjs';
import { runAgent } from './runtime.mjs';

export const askSchema = {
  type: 'object',
  properties: {
    prompt: { type: 'string' },
    model: { type: 'string' },
    maxRounds: { type: 'number' },
  },
  required: ['prompt'],
};

export function normalizeAskInput(input = {}) {
  return {
    prompt: String(input.prompt || ''),
    model: String(input.model || 'perplexity-auto'),
    maxRounds: Number(input.maxRounds || input.max_rounds || 4),
  };
}

export function createServer({ modelClient = createPwmClient(), tools = createResearchTools() } = {}) {
  const server = new Server({ name: 'perplexity-agent', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'pplx_agent.ask',
      description: 'Ask a local Perplexity-backed research agent with web_search and web_fetch tools.',
      inputSchema: askSchema,
    }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'pplx_agent.ask') {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }
    const opts = normalizeAskInput(request.params.arguments);
    const result = await runAgent({ ...opts, model: opts.model, maxRounds: opts.maxRounds, modelClient, tools });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

**Step 4: Install dependency and run test — confirm it passes**

Command:

```bash
cd tools/perplexity-agent && npm install && npm test -- test/server.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add tools/perplexity-agent/package.json tools/perplexity-agent/package-lock.json tools/perplexity-agent/src/server.mjs tools/perplexity-agent/test/server.test.mjs
git commit -m "feat(pplx-agent): expose mcp tool"
```

## Task 9: Add Local Runbook and Smoke Script

**Files:**
- Create: `tools/perplexity-agent/README.md`
- Create: `tools/perplexity-agent/scripts/smoke.mjs`

**Step 1: Write the failing smoke script**

```js
// tools/perplexity-agent/scripts/smoke.mjs
import assert from 'node:assert/strict';
import { createPwmClient } from '../src/pwm-client.mjs';

const client = createPwmClient();
const result = await client.complete([{ role: 'user', content: 'Reply exactly: PPLX_AGENT_OK' }], {
  model: process.env.PPLX_AGENT_MODEL || 'perplexity-auto',
});
assert.match(result.text, /PPLX_AGENT_OK/i);
console.log('PPLX_AGENT_OK');
```

**Step 2: Run smoke — confirm it fails if `pwm` is unavailable, or passes if available**

Command:

```bash
cd tools/perplexity-agent && node scripts/smoke.mjs
```

Expected when `pwm` is running and authenticated: `PPLX_AGENT_OK`.

Expected when unavailable: clear `pwm request failed` or connection error. Do not hide this failure.

**Step 3: Write README**

```md
# Perplexity Agent Sidecar

Local research-only sidecar that gives Perplexity-backed models a small tool loop.

## Run tests

\`\`\`bash
npm test
\`\`\`

## Smoke test the local pwm proxy

\`\`\`bash
node scripts/smoke.mjs
\`\`\`

## CLI

\`\`\`bash
./src/cli.mjs --json "Research the current state of OpenClaw tool calling"
\`\`\`

## MCP

Command:

\`\`\`bash
node /home/frank/openclaw-workspace/tools/perplexity-agent/src/server.mjs
\`\`\`

Tool:

\`\`\`
pplx_agent.ask
\`\`\`

v0 tools are research-only: web_search and web_fetch. Shell/filesystem are intentionally out of scope.
```

**Step 4: Run docs/smoke check**

Command:

```bash
cd tools/perplexity-agent && npm test && node scripts/smoke.mjs
```

Expected: tests pass. Smoke passes only if `pwm` is available; if not, record the exact failure in the task summary.

**Step 5: Commit**

```bash
git add tools/perplexity-agent/README.md tools/perplexity-agent/scripts/smoke.mjs
git commit -m "docs(pplx-agent): add runbook and smoke test"
```

## Task 10: Register as an OpenClaw MCP Entry Manually

**Files:**
- Modify only after reviewing current config path: likely `~/.openclaw/workspace/config/mcporter.json` or the relevant OpenClaw MCP config.
- Do not commit secrets.
- Do not edit assistant identity/system files for this task.

**Step 1: Inspect current MCP config**

Command:

```bash
sed -n '1,220p' /home/frank/.openclaw/workspace/config/mcporter.json
```

Expected: identify existing MCP server shape.

**Step 2: Add a local MCP server entry**

Expected command shape:

```json
{
  "command": "node",
  "args": ["/home/frank/openclaw-workspace/tools/perplexity-agent/src/server.mjs"]
}
```

Use the exact schema already present in the config.

**Step 3: Verify the MCP server lists the tool**

Use the existing MCP invocation pattern for this install. Expected result includes `pplx_agent.ask`.

**Step 4: Commit only repo changes**

If the config lives outside the repo, do not commit it. Commit only any repo docs that mention the registration command.

## Full Verification

Run:

```bash
cd tools/perplexity-agent && npm test
```

Then, if `pwm` is available:

```bash
cd tools/perplexity-agent && node scripts/smoke.mjs
cd tools/perplexity-agent && ./src/cli.mjs --json "Search for OpenClaw and summarize one result"
```

Expected:

- all unit tests pass
- smoke prints `PPLX_AGENT_OK`
- CLI returns JSON with `answer`, `model`, `rounds`, and `trace`

## Handoff Notes

- Use the subagent-driven path for implementation.
- Keep each task isolated and committed.
- If a task encounters unrelated dirty files, ignore them and stage only task files.
- If the real `pwm` smoke fails, keep the sidecar implementation and report the provider/auth failure separately.
