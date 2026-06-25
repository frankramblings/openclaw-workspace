const LOGOS = {
  anthropic: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>',
  openai: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 10.696.453a6.023 6.023 0 0 0-5.75 4.172 6.061 6.061 0 0 0-3.946 2.945 6.024 6.024 0 0 0 .742 7.099 5.98 5.98 0 0 0 .516 4.911 6.046 6.046 0 0 0 6.51 2.9A5.996 5.996 0 0 0 13.26 23.547a6.023 6.023 0 0 0 5.75-4.172 6.061 6.061 0 0 0 3.946-2.945 6.024 6.024 0 0 0-.674-6.609zM13.26 21.047a4.508 4.508 0 0 1-2.886-1.041l.143-.082 4.793-2.769a.777.777 0 0 0 .391-.676V10.34l2.026 1.17a.072.072 0 0 1 .039.061v5.596a4.532 4.532 0 0 1-4.506 4.48zM3.968 17.64a4.473 4.473 0 0 1-.537-3.018l.143.086 4.793 2.769a.79.79 0 0 0 .782 0l5.852-3.379v2.34a.072.072 0 0 1-.029.062l-4.845 2.796a4.532 4.532 0 0 1-6.159-1.656zM2.804 7.922a4.49 4.49 0 0 1 2.348-1.973V11.6a.778.778 0 0 0 .391.676l5.852 3.378-2.026 1.17a.072.072 0 0 1-.068 0L4.456 14.03a4.532 4.532 0 0 1-1.652-6.108zm16.423 3.823L13.375 8.367l2.026-1.17a.072.072 0 0 1 .068 0l4.845 2.796a4.525 4.525 0 0 1-.7 8.08V12.42a.778.778 0 0 0-.387-.676zm2.015-3.025l-.143-.086-4.793-2.769a.79.79 0 0 0-.782 0L9.672 9.243V6.903a.072.072 0 0 1 .029-.062l4.845-2.796a4.525 4.525 0 0 1 6.696 4.675zM8.598 12.66L6.57 11.49a.072.072 0 0 1-.039-.061V5.833a4.525 4.525 0 0 1 7.413-3.48l-.143.082-4.793 2.769a.777.777 0 0 0-.391.676l-.019 6.78zm1.1-2.379 2.607-1.505 2.607 1.505v3.01l-2.607 1.505-2.607-1.505z"/></svg>',
  perplexity: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22.3977 7.0896h-2.3106V.0676l-7.5094 6.3542V.1577h-1.1554v6.1966L4.4904 0v7.0896H1.6023v10.3976h2.8882V24l6.932-6.3591v6.2005h1.1554v-6.0469l6.9318 6.1807v-6.4879h2.8882V7.0896zm-3.4657-4.531v4.531h-5.355l5.355-4.531zm-13.2862.0676 4.8691 4.4634H5.6458V2.6262zM2.7576 16.332V8.245h7.8476l-6.1149 6.1147v1.9723H2.7576zm2.8882 5.0404v-3.8852h.0001v-2.6488l5.7763-5.7764v7.0111l-5.7764 5.2993zm12.7086.0248-5.7766-5.1509V9.0618l5.7766 5.7766v6.5588zm2.8882-5.0652h-1.733v-1.9723L13.3948 8.245h7.8478v8.087z"/></svg>',
};

export function providerKey(endpointId = '', modelId = '') {
  const endpoint = endpointId.toLowerCase();
  if (endpoint.includes('perplexity')) return 'perplexity';
  if (endpoint.includes('claude') || endpoint.includes('anthropic')) return 'anthropic';
  if (endpoint.includes('openai') || endpoint.includes('chatgpt')) return 'openai';

  const model = modelId.toLowerCase();
  if (model.includes('perplexity') || model.includes('sonar')) return 'perplexity';
  if (model.includes('claude') || model.includes('anthropic')) return 'anthropic';
  if (model.includes('gpt') || /^o[1345](?:-|$)/.test(model) || model.includes('openai')) return 'openai';
  return '';
}

export function providerLogo(endpointId, modelId) {
  return LOGOS[providerKey(endpointId, modelId)] || '';
}
