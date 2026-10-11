import { loadSettings, saveSettings } from './store.js';

// One front door for AI. @me sends a system prompt plus text, PDF, and image content,
// and this file turns it into a Gemini request, with retries, model fallbacks, and plain-language errors.
export class AIError extends Error {}

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

// @me runs on Google's Gemini API, with the student's own free key.
export async function provider() { return 'gemini'; }
export const providerName = () => 'Gemini';

export async function hasKey() {
  const s = await loadSettings();
  return !!s.geminiKey;
}

export async function ai(system, content, opts = {}) {
  const s = await loadSettings();
  return gemini(s, system, content, opts);
}

export const parseJSON = t => {
  const clean = t.replace(/```json|```/g, '').trim();
  const start = clean.search(/[\[{]/);
  return JSON.parse(start > 0 ? clean.slice(start) : clean);
};
export async function activeModel() {
  const s = await loadSettings();
  return s.geminiModel || 'gemini-flash-latest';
}

export async function aiJSON(system, content, opts = {}) {
  return parseJSON(await ai(system, content, { ...opts, json: true }));
}

async function withTimeout(fn, ms = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fn(ctrl.signal); }
  catch (e) { if (e.name === 'AbortError') throw new AIError('The AI took too long to respond.'); throw e; }
  finally { clearTimeout(t); }
}

// Turns content (a string, or text and base64 document and image blocks) into Gemini "parts".
function toParts(content) {
  if (typeof content === 'string') return [{ text: content }];
  return content.map(b => {
    if (b.type === 'text') return { text: b.text };
    if (b.type === 'document' && b.source?.type === 'base64') return { inline_data: { mime_type: b.source.media_type, data: b.source.data } };
    if (b.type === 'image' && b.source?.type === 'base64') return { inline_data: { mime_type: b.source.media_type, data: b.source.data } };
    return { text: String(b.text || '') };
  });
}

// Google puts the real reason in error.details[].reason. Turn the common ones into plain advice.
async function geminiError(res, what) {
  let body = null; try { body = await res.json(); } catch { /* not JSON */ }
  const err = body?.error || {};
  const reason = (err.details || []).map(d => d.reason).find(Boolean) || err.status || '';
  const hints = {
    ACCESS_TOKEN_TYPE_UNSUPPORTED: 'Google rejected this key type. Keys starting with "AQ." are having sign-in problems on some accounts. Try making a new key in AI Studio with "Create API key in new project".',
    API_KEY_SERVICE_BLOCKED: 'This key isn\'t allowed to use the Gemini API. In Google Cloud, enable "Generative Language API" for the key\'s project and check the key\'s API restrictions.',
    SERVICE_DISABLED: 'The Gemini API is turned off for this key\'s project. In Google Cloud, enable "Generative Language API".',
    API_KEY_INVALID: 'Google says this isn\'t a valid Gemini API key. Copy it again from Google AI Studio.',
    API_KEY_HTTP_REFERRER_BLOCKED: 'This key has website restrictions that block @me. In Google Cloud Credentials, set the key\'s application restriction to None.',
    RESOURCE_EXHAUSTED: 'You\'ve hit Gemini\'s free-tier limit for now. Wait a bit and try again.',
    UNAVAILABLE: 'Gemini is overloaded right now. That\'s on Google\'s side, and @me already retried and tried other Flash models. Try again in a few minutes.'
  };
  const hint = hints[reason] || (res.status === 429 ? hints.RESOURCE_EXHAUSTED : res.status === 503 ? hints.UNAVAILABLE : '');
  const e = new AIError(`${hint || `Gemini returned ${res.status} ${what}.`} (Google's reason: ${reason || res.status}${err.message && !hint ? `, "${String(err.message).slice(0, 140)}"` : ''})`);
  e.status = res.status; e.reason = reason; return e;
}

// "Failed to fetch" means the browser never got an answer. Ping Google without a key to tell
// "can't reach Google at all" apart from "Google is reachable but this request was blocked".
async function networkError(e) {
  if (!(e instanceof TypeError)) return e;
  let reachable = false;
  try { const r = await fetch(`${GEMINI}/models`, { cache: 'no-store' }); reachable = r.status > 0; } catch { reachable = false; }
  return new AIError(reachable
    ? 'Google is reachable, but this request was blocked before it got there. Reload @me on chrome://extensions (Chrome only applies new permissions after a reload), then try again. If it keeps happening, turn off ad blockers or privacy extensions for a moment.'
    : 'Can\'t reach Google\'s Gemini servers at all. Check your internet connection, and try turning off any VPN or ad blocker. Some school or work Wi-Fi networks block AI services, so a phone hotspot is a quick way to test.');
}

export const cleanKey = k => String(k || '').trim().replace(/^["']|["']$/g, '');

export async function listGeminiModels(key) {
  key = cleanKey(key);
  let res;
  for (const pause of [0, 1500, 4000]) {   // the model list can be "high demand" too
    if (pause) await new Promise(r => setTimeout(r, pause));
    try { res = await fetch(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } }); }
    catch (e) { throw await networkError(e); }
    if (![500, 503, 504].includes(res.status)) break;
  }
  if (!res.ok) throw await geminiError(res, 'when listing models');
  const data = await res.json();
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }))
    .filter(m => /flash/i.test(m.id) && !/(image|tts|live|audio|embed)/i.test(m.id));
}

let lastModel = null;
export const lastModelUsed = () => lastModel;
const busy = e => e?.status === 503 || e?.status === 500 || e?.reason === 'UNAVAILABLE';

// Free-tier Gemini is often "high demand". Retry the chosen model a couple of times with a short wait,
// then try other Flash models (Flash-Lite first, since it's usually the least busy).
async function gemini(s, system, content, opts = {}) {
  if (!s.geminiKey) throw new AIError('No Gemini API key yet. Add one in @me Settings.');
  s = { ...s, geminiKey: cleanKey(s.geminiKey) };
  const first = s.geminiModel || 'gemini-flash-latest';
  let lastErr;
  for (const wait of [0, 1500, 4000]) {
    if (wait) await new Promise(r => setTimeout(r, wait));
    try { const t = await geminiOnce(s, first, system, content, opts); lastModel = first; return t; }
    catch (e) { lastErr = e; if (!busy(e)) throw e; }
  }
  let others = [];
  try { others = (await listGeminiModels(s.geminiKey)).map(m => m.id).filter(id => id !== first); } catch { /* keep the original error */ }
  others.sort((a, b) => (/lite/.test(b) - /lite/.test(a)) || (/latest/.test(b) - /latest/.test(a)));
  for (const m of others.slice(0, 3)) {
    try { const t = await geminiOnce(s, m, system, content, opts); lastModel = m; return t; }
    catch (e) { lastErr = e; if (!busy(e)) break; }
  }
  throw lastErr;
}

async function geminiOnce(s, modelId, system, content, { maxTokens = 1500, json = false, schema = null } = {}, retried = false) {
  const model = modelId;
  // Newer Gemini models "think" before answering, and that thinking counts toward the output limit,
  // so give them extra room or short answers come back empty.
  const generationConfig = { maxOutputTokens: Math.max(2048, maxTokens * 4) };
  if (json) generationConfig.responseMimeType = 'application/json';
  // Structured output: Gemini fills in exactly this shape, so answers always parse.
  if (json && schema) generationConfig.responseSchema = schema;
  return withTimeout(async signal => {
    let res;
    try {
      res = await fetch(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': s.geminiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: toParts(content) }],
          generationConfig
        })
      });
    } catch (e) { if (e.name === 'AbortError') throw e; throw await networkError(e); }
    if (res.status === 404 && !retried) {
      // The saved model was retired or renamed. Pick a current Flash model and try once more.
      const models = await listGeminiModels(s.geminiKey);
      const pick = models.find(m => /flash-latest/.test(m.id)) || models[0];
      if (!pick) throw new AIError(`Gemini model "${model}" isn't available. Pick another in Settings.`);
      await saveSettings({ geminiModel: pick.id });
      return geminiOnce({ ...s, geminiModel: pick.id }, pick.id, system, content, { maxTokens, json, schema }, true);
    }
    // If a model doesn't accept the schema, fall back to plain JSON mode instead of failing.
    if (res.status === 400 && schema) return geminiOnce(s, modelId, system, content, { maxTokens, json }, retried);
    if (!res.ok) throw await geminiError(res, 'for that request');
    const data = await res.json();
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('\n');
    if (!text) throw new AIError(cand?.finishReason === 'SAFETY' ? 'Gemini declined to answer that one.' : 'Gemini sent back an empty answer.');
    return text;
  });
}
