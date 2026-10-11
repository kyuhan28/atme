import { loadSettings, saveSettings, resetAll } from './lib/store.js';
import { ai, listGeminiModels, activeModel, lastModelUsed } from './lib/ai.js';
import * as gcal from './lib/gcal.js';
import * as canvas from './lib/canvas.js';

const $ = id => document.getElementById(id);
const say = (id, text, ok) => { $(id).textContent = text; $(id).className = 'status ' + (ok === true ? 'ok' : ok === false ? 'bad' : ''); };

const s = await loadSettings();
$('geminiKey').value = s.geminiKey;
if (s.geminiModel && ![...$('geminiModel').options].some(o => o.value === s.geminiModel)) $('geminiModel').add(new Option(s.geminiModel, s.geminiModel));
$('geminiModel').value = s.geminiModel || 'gemini-flash-latest';
$('domain').value = s.canvasDomain; $('token').value = s.canvasToken; $('demo').checked = s.demoSessions;

$('saveGemini').onclick = async () => { await saveSettings({ geminiKey: $('geminiKey').value.trim(), geminiModel: $('geminiModel').value }); say('geminiMsg', 'Saved.', true); };
$('testGemini').onclick = async () => {
  const key = $('geminiKey').value.trim();
  if (!key) return say('geminiMsg', 'Paste your Gemini API key first.', false);
  say('geminiMsg', 'Step 1 of 2: checking your key with Google…');
  try {
    const models = await listGeminiModels(key);
    const cur = $('geminiModel').value;
    $('geminiModel').innerHTML = '';
    if (!models.some(m => m.id === 'gemini-flash-latest')) $('geminiModel').add(new Option('Gemini Flash (latest)', 'gemini-flash-latest'));
    models.forEach(m => $('geminiModel').add(new Option(m.label, m.id)));
    $('geminiModel').value = [...$('geminiModel').options].some(o => o.value === cur) ? cur : $('geminiModel').options[0].value;
    await saveSettings({ geminiKey: key, geminiModel: $('geminiModel').value });
    say('geminiMsg', `Step 2 of 2: asking ${$('geminiModel').value} a test question. If Google is busy this can take a few seconds…`);
    const r = await ai('Reply with exactly: ready', 'ping', { maxTokens: 10 });
    const used = lastModelUsed() || await activeModel(), picked = $('geminiModel').value;
    say('geminiMsg', `Connected using ${used}${used !== picked ? ` (${picked} was busy, so I used a backup model)` : ''}. Gemini says "${r.trim().slice(0, 40)}". You're all set.`, true);
  } catch (e) { say('geminiMsg', e.message, false); }
};
$('geminiModel').onchange = () => saveSettings({ geminiModel: $('geminiModel').value });

async function gStatus() { say('gMsg', (await gcal.isConnected()) ? 'Connected.' : 'Not connected yet.', await gcal.isConnected() || undefined); }
$('gConnect').onclick = async () => {
  say('gMsg', 'Opening Google sign-in…');
  try { await gcal.connect(); say('gMsg', 'Connected. @me will create an "@me Study" calendar the first time it plans.', true); }
  catch (e) { say('gMsg', `${e.message}. Make sure manifest.json has your OAuth client ID (see README).`, false); }
};
$('gDisconnect').onclick = async () => { await gcal.disconnect(); say('gMsg', 'Disconnected.'); };
gStatus();

$('cConnect').onclick = async () => {
  const domain = canvas.cleanDomain($('domain').value), token = $('token').value.trim();
  if (!domain || !token) return say('cMsg', 'Add both your Canvas address and token.', false);
  const granted = await canvas.requestPermission(domain);   // must run from a click
  if (!granted) return say('cMsg', 'Chrome permission was denied, so @me can\'t reach Canvas.', false);
  await saveSettings({ canvasDomain: domain, canvasToken: token });
  try { const name = await canvas.testConnection(); say('cMsg', `Connected as ${name}. Go back to @me and choose "Import from Canvas".`, true); }
  catch (e) { say('cMsg', e.message, false); }
};
$('cTest').onclick = async () => {
  try { const name = await canvas.testConnection(); say('cMsg', `Connected as ${name}.`, true); } catch (e) { say('cMsg', e.message, false); }
};
$('demo').onchange = async e => { await saveSettings({ demoSessions: e.target.checked }); };
$('reset').onclick = async () => {
  if (!confirm('Clear all your classes, plans, and history from @me?')) return;
  await resetAll(); await chrome.action.setBadgeText({ text: '' }); say('rMsg', 'Cleared. Reload the @me tab to start fresh.', true);
};
