// LLM factory — OpenAI / Anthropic / Gemini behind one streaming interface.
// stream({ system, turns:[{role,text}], imageDataUrls, maxTokens, onToken }) -> Promise<fullText>
// imageDataUrls: optional array of data: URLs, all attached to the final user turn.

function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

async function streamOpenAI({ apiKey, model, system, turns, imageDataUrls, maxTokens, onToken }) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey });
  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrls && imageDataUrls.length && t.role === 'user') {
      messages.push({ role: 'user', content: [
        { type: 'text', text: t.text },
        ...imageDataUrls.map((url) => ({ type: 'image_url', image_url: { url } }))
      ] });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  const stream = await client.chat.completions.create({ model, messages, stream: true, max_tokens: maxTokens });
  let full = '';
  for await (const part of stream) {
    const d = part.choices && part.choices[0] && part.choices[0].delta && part.choices[0].delta.content;
    if (d) { full += d; onToken(d); }
  }
  return full;
}

async function streamAnthropic({ apiKey, model, system, turns, imageDataUrls, maxTokens, onToken }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const messages = turns.map((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrls && imageDataUrls.length && t.role === 'user') {
      const content = imageDataUrls
        .map(stripDataUrl)
        .filter(Boolean)
        .map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } }));
      content.push({ type: 'text', text: t.text });
      return { role: 'user', content };
    }
    return { role: t.role, content: t.text };
  });
  const stream = await client.messages.create({ model, max_tokens: maxTokens, system, messages, stream: true });
  let full = '';
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { full += ev.delta.text; onToken(ev.delta.text); }
  }
  return full;
}

async function streamGemini({ apiKey, model, system, turns, imageDataUrls, maxTokens, onToken }) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const contents = turns.map((t, i) => {
    const last = i === turns.length - 1;
    const parts = [{ text: t.text }];
    if (last && imageDataUrls && imageDataUrls.length && t.role === 'user') {
      imageDataUrls.map(stripDataUrl).filter(Boolean).forEach((img) => {
        parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
      });
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });
  const stream = await ai.models.generateContentStream({
    model, contents, config: { systemInstruction: system, maxOutputTokens: maxTokens }
  });
  let full = '';
  for await (const chunk of stream) {
    const t = chunk && chunk.text;
    if (t) { full += t; onToken(t); }
  }
  return full;
}

function isRateLimited(err) {
  const status = err && (err.status || err.statusCode || (err.error && err.error.code));
  if (status === 429) return true;
  return /429|too many requests|rate.?limit/i.test((err && err.message) || '');
}

const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_MS = 2000; // 2s, 4s, 8s

function createLLM(settings) {
  const provider = settings.provider;
  const keys = settings.apiKeys || {};
  const apiKey = keys[provider];
  const tier = settings.smart ? 'smart' : 'fast';
  const model = (settings.models[provider] || {})[tier];
  // Generous enough that a full code answer (code + explanation + complexity)
  // doesn't get cut off mid-response.
  const maxTokens = settings.smart ? 6000 : 3000;

  return {
    provider, model, apiKey,
    ready: !!apiKey && !!model,
    async stream(params) {
      const runOnce = () => {
        // Track whether this attempt emitted any tokens before failing — once
        // a provider starts streaming, retrying from scratch would duplicate
        // text already shown, so only 429s caught before any token is unsafe to retry.
        let gotToken = false;
        const args = { apiKey, model, maxTokens, ...params, onToken: (t) => { gotToken = true; params.onToken(t); } };
        const run = provider === 'openai' ? streamOpenAI
          : provider === 'anthropic' ? streamAnthropic
          : provider === 'gemini' ? streamGemini
          : null;
        if (!run) throw new Error('unknown provider: ' + provider);
        return run(args).catch((err) => { err.gotToken = gotToken; throw err; });
      };
      for (let attempt = 0; ; attempt++) {
        try {
          return await runOnce();
        } catch (err) {
          if (err.gotToken || !isRateLimited(err) || attempt >= RATE_LIMIT_RETRIES) throw err;
          const waitMs = RATE_LIMIT_BASE_MS * Math.pow(2, attempt);
          if (params.onRateLimit) params.onRateLimit(attempt + 1, waitMs);
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
    }
  };
}

module.exports = { createLLM };
