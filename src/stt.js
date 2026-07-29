// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API — we transcribe with whatever audio-capable key is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
const { pcmToWav } = require('./wav');

async function transcribeOpenAI(apiKey, wav) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey });
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create({ file, model: 'whisper-1' });
  return (res.text || '').trim();
}

async function transcribeGemini(apiKey, model, wav) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [
      { text: 'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.' },
      { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
    ] }]
  });
  return ((res && res.text) || '').trim();
}

function createSTT(settings) {
  const keys = settings.apiKeys || {};
  // Take the Gemini id from settings rather than hardcoding a second one here —
  // a pinned id rots independently of the store defaults (that's how this path
  // kept calling the long-retired gemini-1.5-flash after the defaults moved on).
  const geminiModel = ((settings.models || {}).gemini || {}).fast || 'gemini-flash-latest';
  // 'auto' keeps the original behaviour: prefer Whisper, fall back to Gemini.
  // An explicit choice is honoured exactly — no silent fallback to the provider
  // the user just deselected.
  const want = settings.sttProvider || 'auto';
  const chain = [
    { p: 'openai', key: keys.openai, fn: (wav) => transcribeOpenAI(keys.openai, wav) },
    { p: 'gemini', key: keys.gemini, fn: (wav) => transcribeGemini(keys.gemini, geminiModel, wav) }
  ].filter((c) => c.key && (want === 'auto' || want === c.p));

  return {
    available: chain.length > 0,
    providers: chain.map((c) => c.p),
    // Lets the caller say *which* key is missing instead of listing both.
    wanted: want,
    async transcribe(pcm) {
      if (!chain.length || !pcm || pcm.length < 3200) return { text: '' };
      const wav = pcmToWav(pcm, 16000, 1);
      let lastErr = null;
      for (const c of chain) {
        try {
          const text = await c.fn(wav);
          return { text, provider: c.p };
        } catch (e) {
          lastErr = { status: e && e.status, code: e && e.code, message: (e && e.message) || String(e), provider: c.p };
        }
      }
      return { text: '', error: lastErr };
    }
  };
}

module.exports = { createSTT };
