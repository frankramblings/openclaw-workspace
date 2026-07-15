export function compactToolResult(value, maxChars = 6000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}
