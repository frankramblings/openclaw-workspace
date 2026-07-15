const TOOL_RE = /(?:^|\n)TOOL\s+([A-Za-z][A-Za-z0-9_-]*)\s+(\{[\s\S]*\})\s*$/;
const TOOL_PREFIX_RE = /(?:^|\n)TOOL\s+([A-Za-z][A-Za-z0-9_-]*)\s+([\s\S]+)\s*$/;
const THOUGHT_RE = /(?:^|\n)THOUGHT:\s*([^\n]+)/;

export function parseAssistantOutput(text) {
  const raw = String(text || '').trim();
  if (raw.startsWith('FINAL:')) {
    return { type: 'final', answer: raw.slice('FINAL:'.length).trim() };
  }
  const match = raw.match(TOOL_RE);
  if (!match) {
    const malformedMatch = raw.match(TOOL_PREFIX_RE);
    if (malformedMatch) {
      const [, tool, jsonText] = malformedMatch;
      return { type: 'invalid_tool_json', tool, raw: jsonText, error: 'JSON parse error' };
    }
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
