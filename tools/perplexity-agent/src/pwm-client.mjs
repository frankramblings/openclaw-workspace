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
