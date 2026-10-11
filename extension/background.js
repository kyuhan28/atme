import { loadState, saveState, loadSettings } from './lib/store.js';
import { createPlanner } from './lib/planner.js';
import * as gcal from './lib/gcal.js';
import * as canvas from './lib/canvas.js';
import { enableFocus, disableFocus } from './lib/focus.js';
import { today, fmt, dayDiff, relDay, shortName, isWeekday, dLabel, when } from './lib/util.js';

const APP_URL = chrome.runtime.getURL('app.html');

async function openApp(query = '') {
  const tabs = await chrome.tabs.query({ url: APP_URL + '*' });
  if (tabs[0]) { await chrome.tabs.update(tabs[0].id, { active: true, url: query ? APP_URL + query : undefined }); await chrome.windows.update(tabs[0].windowId, { focused: true }); }
  else await chrome.tabs.create({ url: APP_URL + query });
}

async function updateBadge(S) {
  S = S || await loadState();
  const n = S.alerts.length;
  await chrome.action.setBadgeBackgroundColor({ color: '#B4232C' });
  await chrome.action.setBadgeText({ text: n ? '!' : '' });
  await chrome.action.setTitle({ title: n ? `@me: ${n} calendar change${n > 1 ? 's' : ''} to review` : '@me' });
}

function notify(id, title, message) {
  chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 2 });
}

async function scheduleBriefing() {
  const S = await loadState();
  await chrome.alarms.clear('briefing');
  if (!S.extras.brief) return;
  const next = new Date(); next.setHours(S.extras.brief, 0, 0, 0);
  if (next <= new Date()) next.setDate(next.getDate() + 1);
  chrome.alarms.create('briefing', { when: next.getTime() });
}

async function ensureAlarms() {
  const poll = await chrome.alarms.get('poll');
  if (!poll) chrome.alarms.create('poll', { delayInMinutes: 1, periodInMinutes: 30 });
  const gpoll = await chrome.alarms.get('gpoll');
  if (!gpoll) chrome.alarms.create('gpoll', { delayInMinutes: 2, periodInMinutes: 15 });
  await scheduleBriefing();
}

// Checks Canvas for anything new. New quizzes and exams get prep sessions, go on Google Calendar,
// and raise the red "!" so the student knows something changed.
async function pollCanvas({ manual = false } = {}) {
  const settings = await loadSettings();
  if (!settings.canvasDomain || !settings.canvasToken) return { ok: false, reason: 'Canvas not set up' };
  if (!(await canvas.hasPermission(settings.canvasDomain))) return { ok: false, reason: 'No Canvas permission' };
  const S = await loadState();
  if (!S.courses.some(c => c.source === 'Canvas')) return { ok: false, reason: 'Canvas not imported yet' };
  const P = createPlanner(S);
  let results;
  try { results = await canvas.refreshImported(S.courses.filter(c => c.canvasId).map(c => c.canvasId)); } catch (e) { return { ok: false, reason: e.message }; }
  const seen = new Set(S.canvasSeen);
  const fresh = [];
  for (const r of results) {
    const newOnes = r.items.filter(i => !seen.has(i.canvasId));
    newOnes.forEach(i => seen.add(i.canvasId));
    if (!newOnes.length) continue;
    const m = P.mergeCourse({ ...r, items: newOnes });
    fresh.push(...m.newItems);
  }
  S.canvasSeen = [...seen];
  if (!fresh.length) { await saveState(S, 'bg'); return { ok: true, found: 0 }; }

  const created = [];
  if (S.prefs) {
    for (const it of fresh) {
      const soon = dayDiff(today(), it.date) <= 3;
      if ((it.type === 'quiz' || it.type === 'exam') && soon) { it.surprise = true; created.push(...P.surprisePrep(it)); }
      else created.push(...P.buildPlan([it.id]).created);
    }
  }
  let synced = false;
  if (created.length && await gcal.isConnected()) {
    try { await gcal.refreshBusy(S); await gcal.syncPlan(S, P.itemById); synced = true; } catch (e) { /* will retry from the dashboard */ }
  }
  if (S.extras.dueCal && await gcal.isConnected()) {
    try { await gcal.syncDeadlines(S); } catch (e) { /* will retry from the dashboard */ }
  }
  const big = fresh.find(i => i.type !== 'assignment') || fresh[0];
  const summary = `${big.course} posted ${fresh.length > 1 ? `${fresh.length} new items, including ` : ''}${big.name} (${relDay(big.date)}).` +
    (created.length ? ` I added ${created.length} prep session${created.length > 1 ? 's' : ''}${synced ? ' to your Google Calendar' : ''}.` : '');
  S.alerts.push({ summary, ids: created.map(b => b.id), at: Date.now() });
  S.fresh.push(...created.map(b => b.id));
  S.memory.push({ t: `${big.course} posts things on Canvas with short notice` });
  await saveState(S, 'bg');
  await updateBadge(S);
  notify('atme-alert', `❗ ${big.course}: ${big.name}`, summary);
  return { ok: true, found: fresh.length, created: created.length, manual };
}

// Notices new events on the student's Google Calendar. If one lands on top of a study session,
// @me moves the session, updates "@me Study", and raises the red ❗.
async function pollGoogle() {
  if (!(await gcal.isConnected())) return { ok: false, reason: 'Google not connected' };
  const S = await loadState();
  if (!S.prefs || !S.courses.length) return { ok: false, reason: 'not set up yet' };
  const prev = S.gevents;
  try { await gcal.refreshEvents(S); } catch (e) { return { ok: false, reason: e.message }; }
  const added = prev ? gcal.newEvents(prev, S.gevents) : [];
  const P = createPlanner(S);
  const r = P.resolveConflicts();
  if (r.moved.length || r.dropped.length) {
    try { await gcal.syncPlan(S, P.itemById); } catch { /* the dashboard will retry */ }
    const what = added.find(x => !x.allDay);
    const summary = `${what ? `"${what.title}" on ${dLabel(what.date)} overlapped your study time, so ` : 'Your Google Calendar changed, so '}I moved ${r.moved.length} session${r.moved.length !== 1 ? 's' : ''}${r.dropped.length ? ` and dropped ${r.dropped.length} that no longer fit` : ''}.` +
      (r.moved[0] ? ` ${r.moved[0].title} is now ${when(r.moved[0])}.` : '');
    S.alerts.push({ summary, ids: r.moved.map(b => b.id), at: Date.now() });
    S.fresh.push(...r.moved.map(b => b.id));
    await saveState(S, 'bg'); await updateBadge(S);
    notify('atme-alert', '❗ @me moved a study session', summary);
    return { ok: true, moved: r.moved.length };
  }
  await saveState(S, 'bg');
  return { ok: true, moved: 0, added: added.length };
}

async function sendBriefing() {
  const S = await loadState();
  await scheduleBriefing();
  const T = today();
  if (!isWeekday(T) || !S.courses.length) return;
  const P = createPlanner(S);
  const sessions = S.plan.filter(b => b.date === T && b.status === 'planned').sort((a, b) => a.s - b.s);
  const classes = P.eventsOn(T).filter(e => e.kind !== 'gbusy');
  const exam = P.liveItems().filter(i => i.type === 'exam' && i.date >= T).sort((a, b) => a.date.localeCompare(b.date))[0];
  const bits = [];
  if (sessions.length) bits.push(`${sessions.length} study session${sessions.length > 1 ? 's' : ''}, first at ${fmt(sessions[0].s)}`);
  if (classes.length) bits.push(`${classes.length} class${classes.length > 1 ? 'es' : ''}`);
  if (exam) { const d = dayDiff(T, exam.date); bits.push(d === 0 ? `${exam.course} ${shortName(exam)} is TODAY` : `${exam.course} ${shortName(exam)} in ${d} day${d > 1 ? 's' : ''}`); }
  notify('atme-brief', 'Good morning! ☀️ Here\'s your day', bits.length ? bits.join('. ') + '.' : 'Nothing on the schedule. Enjoy the breathing room!');
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await ensureAlarms(); await updateBadge();
  if (reason === 'install') openApp();
});
chrome.runtime.onStartup.addListener(async () => {
  // A session can't still be running after Chrome restarts, so clear any leftover site blocking.
  const S = await loadState(); if (!S.active || S.active.end < Date.now()) await disableFocus();
  await ensureAlarms(); await updateBadge();
});

chrome.alarms.onAlarm.addListener(async a => {
  if ((await chrome.storage.local.get('atme:safe'))['atme:safe']) {   // safe mode: do nothing in the background
    if (a.name === 'session-end') await disableFocus();
    return;
  }
  if (a.name === 'poll') pollCanvas();
  if (a.name === 'gpoll') pollGoogle();
  if (a.name === 'briefing') sendBriefing();
  if (a.name === 'session-end') {
    await disableFocus();
    notify('atme-session', 'Session done! 🎉', 'Nice work. Open @me for a quick quiz and check-in.');
  }
});

chrome.notifications.onClicked.addListener(id => {
  chrome.notifications.clear(id);
  openApp(id === 'atme-brief' ? '?brief=1' : id === 'atme-alert' ? '?review=1' : '');
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg?.type) {
      case 'session-start':
        if (msg.focus && !(await chrome.storage.local.get('atme:safe'))['atme:safe']) await enableFocus();
        chrome.alarms.create('session-end', { when: msg.end });
        return { ok: true };
      case 'session-stop':
        await chrome.alarms.clear('session-end'); await disableFocus();
        return { ok: true };
      case 'schedule-briefing': await scheduleBriefing(); return { ok: true };
      case 'poll-now': return pollCanvas({ manual: true });
      case 'gpoll-now': return pollGoogle();
      case 'open-app': await openApp(msg.query || ''); return { ok: true };
      case 'state-changed': await updateBadge(); return { ok: true };
      default: return null;
    }
  })().then(reply, e => reply({ ok: false, reason: e.message }));
  return true;
});
