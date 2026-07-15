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
