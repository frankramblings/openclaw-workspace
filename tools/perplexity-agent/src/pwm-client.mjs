const MODEL_ALIASES = new Map([
  ['perplexity-auto', 'auto'],
  ['perplexity-sonar', 'sonar'],
  ['gpt-5.4', 'gpt54'],
  ['gpt-5.5', 'gpt55'],
  ['claude-sonnet-4-6', 'claude_sonnet'],
  ['claude-opus-4-1', 'claude_opus'],
  ['gemini-3.1-pro', 'gemini_pro'],
  ['nemotron-3-super', 'nemotron'],
  ['kimi-k2.6', 'kimi_k26'],
]);

export function normalizePwmModel(model = 'perplexity-auto') {
  return MODEL_ALIASES.get(model) || model;
}

export function createPwmClient({
  baseUrl = process.env.PPLX_AGENT_PWM_BASE_URL || 'http://127.0.0.1:18080/v1',
  apiKey = process.env.PPLX_AGENT_PWM_API_KEY || 'perplexity-local',
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation required');
  return {
    async complete(messages, { model = 'perplexity-auto' } = {}) {
      const pwmModel = normalizePwmModel(model);
      const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: pwmModel, messages, temperature: 0.2 }),
      });
      if (!res.ok) {
        throw new Error(`pwm request failed: ${res.status} ${await res.text()}`);
      }
      const data = await res.json();
      return { text: data?.choices?.[0]?.message?.content || '' };
    },
  };
}
