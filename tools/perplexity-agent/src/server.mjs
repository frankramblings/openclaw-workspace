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
