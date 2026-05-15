// src/services/llmClient.js
// Minimal provider-agnostic LLM client used by the Captain feature set.
// Reads CAPTAIN_LLM_PROVIDER and dispatches to one of three HTTP backends:
//   - groq      (OpenAI-compatible chat/completions)
//   - anthropic (Messages API)
//   - openai    (chat/completions)
// Uses native fetch (Node 18+); no SDK or extra deps. 30s timeout per call.
// Exports: callLLM, isLLMConfigured, LLMNotConfiguredError.

'use strict';

const TIMEOUT_MS = 30000;

class LLMNotConfiguredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LLMNotConfiguredError';
  }
}

function getProvider() {
  const raw = process.env.CAPTAIN_LLM_PROVIDER;
  if (!raw || !raw.trim()) return null;
  return raw.trim().toLowerCase();
}

function isLLMConfigured() {
  const provider = getProvider();
  if (!provider) return false;
  if (provider === 'groq') return !!(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim());
  if (provider === 'anthropic') return !!(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim());
  if (provider === 'openai') return !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());
  return false;
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readErrorBody(res) {
  try {
    return await res.text();
  } catch (_e) {
    return '<unreadable response body>';
  }
}

async function callGroq(systemPrompt, userPrompt, maxTokens, jsonMode) {
  const body = {
    model: process.env.CAPTAIN_LLM_MODEL || 'llama-3.1-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: maxTokens,
    temperature: 0.2,
  };
  if (jsonMode === true) body.response_format = { type: 'json_object' };

  const res = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await readErrorBody(res);
    throw new Error(`[llmClient] groq HTTP ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

async function callAnthropic(systemPrompt, userPrompt, maxTokens, jsonMode) {
  const sys = jsonMode === true
    ? `${systemPrompt} Respond only with valid JSON. No markdown.`
    : systemPrompt;

  const body = {
    model: process.env.CAPTAIN_LLM_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: maxTokens,
    system: sys,
    messages: [{ role: 'user', content: userPrompt }],
  };

  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await readErrorBody(res);
    throw new Error(`[llmClient] anthropic HTTP ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.content[0].text;
}

async function callOpenAI(systemPrompt, userPrompt, maxTokens, jsonMode) {
  const body = {
    model: process.env.CAPTAIN_LLM_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: maxTokens,
    temperature: 0.2,
  };
  if (jsonMode === true) body.response_format = { type: 'json_object' };

  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await readErrorBody(res);
    throw new Error(`[llmClient] openai HTTP ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

async function callLLM(systemPrompt, userPrompt, options) {
  const provider = getProvider();
  if (!provider) {
    throw new LLMNotConfiguredError('CAPTAIN_LLM_PROVIDER not set');
  }

  const opts = options || {};
  const maxTokens = (opts.maxTokens != null)
    ? opts.maxTokens
    : (parseInt(process.env.CAPTAIN_LLM_MAX_TOKENS, 10) || 2000);
  const jsonMode = opts.jsonMode === true;

  if (provider === 'groq') return callGroq(systemPrompt, userPrompt, maxTokens, jsonMode);
  if (provider === 'anthropic') return callAnthropic(systemPrompt, userPrompt, maxTokens, jsonMode);
  if (provider === 'openai') return callOpenAI(systemPrompt, userPrompt, maxTokens, jsonMode);

  throw new Error(`[llmClient] unknown CAPTAIN_LLM_PROVIDER: ${provider}`);
}

module.exports = {
  callLLM,
  isLLMConfigured,
  LLMNotConfiguredError,
};
