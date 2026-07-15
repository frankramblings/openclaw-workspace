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
