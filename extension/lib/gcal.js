import { addDays, today, dateAt, iso, TZ, wkey, pad, dLabel, fmt } from './util.js';
import { STYPES, createPlanner } from './planner.js';

const API = 'https://www.googleapis.com/calendar/v3';
export class GcalError extends Error {}

async function getToken(interactive) {
  try {
    const r = await chrome.identity.getAuthToken({ interactive });
    const token = typeof r === 'string' ? r : r?.token;
    if (!token) throw new GcalError('Google sign-in did not return a token.');
    return token;
  } catch (e) {
    throw new GcalError(interactive ? `Google sign-in failed: ${e.message || e}` : 'Not connected to Google Calendar.');
  }
}

async function api(path, { method = 'GET', body, interactive = false, retry = true } = {}) {
  const token = await getToken(interactive);
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401 && retry) {
    await chrome.identity.removeCachedAuthToken({ token });
    return api(path, { method, body, interactive, retry: false });
  }
  if (res.status === 204) return null;
  if (!res.ok) {
    const err = new GcalError(`Google Calendar ${method} ${path.split('?')[0]} failed (${res.status})`);
    err.status = res.status; throw err;
  }
  return res.json();
}

export async function connect() { await getToken(true); return true; }
export async function isConnected() { try { await getToken(false); return true; } catch { return false; } }
export async function disconnect() {
  try { const t = await getToken(false); await chrome.identity.removeCachedAuthToken({ token: t }); await fetch(`https://oauth2.googleapis.com/revoke?token=${t}`, { method: 'POST' }); } catch { /* already disconnected */ }
}

// Splits a start/end time into per-day pieces, as decimal hours, for the calendar view.
function splitByDay(startIso, endIso, cb) {
  let s = new Date(startIso); const e = new Date(endIso);
  while (s < e) {
    const dayEnd = new Date(s); dayEnd.setHours(24, 0, 0, 0);
    const segEnd = e < dayEnd ? e : dayEnd;
    const sh = s.getHours() + s.getMinutes() / 60;
    const eh = segEnd.getTime() === dayEnd.getTime() ? 24 : segEnd.getHours() + segEnd.getMinutes() / 60;
    if (eh - sh > 0.05) cb(iso(s), sh, eh);
    s = segEnd;
  }
}

// Reads events (with their names) from the user's primary Google Calendar, so @me shows them
// and plans around them. Falls back to anonymous busy times if the user hasn't granted event access.
export async function refreshEvents(S, days = 35) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + days);
  const items = []; let pageToken = '';
  try {
    do {
      const q = `singleEvents=true&orderBy=startTime&maxResults=250&timeMin=${encodeURIComponent(start.toISOString())}&timeMax=${encodeURIComponent(end.toISOString())}${pageToken ? `&pageToken=${pageToken}` : ''}`;
      const r = await api(`/calendars/primary/events?${q}`);
      items.push(...(r.items || []));
      const next = r.nextPageToken || '';
      pageToken = next && next !== pageToken ? next : '';   // stop if Google repeats a page
    } while (pageToken && items.length < 1500);
  } catch (e) {
    if (e.status === 403) { const n = await refreshBusy(S, days); S.gevents = null; return { mode: 'busy', count: n }; }
    throw e;
  }
  const out = {};
  for (const ev of items) {
    if (ev.status === 'cancelled') continue;
    if (ev.extendedProperties?.private?.atmeBlock || /^📚/.test(ev.summary || '')) continue;   // our own study sessions
    const me = (ev.attendees || []).find(a => a.self);
    if (me && me.responseStatus === 'declined') continue;
    if (['workingLocation', 'birthday'].includes(ev.eventType)) continue;   // these never mean "busy"
    const title = String(ev.summary || 'Busy').slice(0, 40);
    // Timed events 12 hours or longer ("Fall semester", "Trip", "Busy") are almost never real busy time.
    // Show them like all-day events instead of letting them block whole days.
    const longEvent = ev.start?.dateTime && ev.end?.dateTime && (new Date(ev.end.dateTime) - new Date(ev.start.dateTime)) >= 12 * 36e5;
    if (longEvent) {
      const last = new Date(new Date(ev.end.dateTime) - 1);
      for (let d = iso(new Date(ev.start.dateTime)); d <= iso(last); d = addDays(d, 1)) (out[d] = out[d] || []).push({ allDay: true, title, id: ev.id, long: true });
      continue;
    }
    if (ev.start?.date) {
      for (let d = ev.start.date; d < (ev.end?.date || addDays(ev.start.date, 1)); d = addDays(d, 1)) (out[d] = out[d] || []).push({ allDay: true, title, id: ev.id });
      continue;
    }
    if (!ev.start?.dateTime || !ev.end?.dateTime) continue;
    splitByDay(ev.start.dateTime, ev.end.dateTime, (d, sh, eh) => (out[d] = out[d] || []).push({ s: sh, e: eh, title, id: ev.id, free: ev.transparency === 'transparent' }));
  }
  S.gevents = out; S.gbusyAt = Date.now();
  return { mode: 'events', count: items.length };
}

// Lists events that are in `next` but weren't in `prev`, so @me can mention what you just added.
export function newEvents(prev, next) {
  const seen = new Set(Object.values(prev || {}).flat().map(x => x.id));
  const out = [];
  for (const [date, list] of Object.entries(next || {})) for (const x of list) if (!seen.has(x.id) && !out.some(o => o.id === x.id)) out.push({ ...x, date });
  return out;
}

// Pulls busy times from the user's primary Google Calendar so @me plans around them.
export async function refreshBusy(S, days = 28) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + days);
  const r = await api('/freeBusy', { method: 'POST', body: { timeMin: start.toISOString(), timeMax: end.toISOString(), timeZone: TZ, items: [{ id: 'primary' }] } });
  const busy = r?.calendars?.primary?.busy || [];
  const out = {};
  for (const b of busy) splitByDay(b.start, b.end, (d, sh, eh) => (out[d] = out[d] || []).push([sh, eh]));
  S.gbusy = out; S.gbusyAt = Date.now();
  return busy.length;
}

async function ensureNamed(S, idKey, mapKey, summary, description) {
  S.gcal[mapKey] = S.gcal[mapKey] || {};
  if (S.gcal[idKey]) {
    try { await api(`/calendars/${encodeURIComponent(S.gcal[idKey])}`); return S.gcal[idKey]; }
    catch (e) { if (e.status !== 404 && e.status !== 403) throw e; S.gcal[idKey] = null; S.gcal[mapKey] = {}; }
  }
  const cal = await api('/calendars', { method: 'POST', body: { summary, description, timeZone: TZ } });
  S.gcal[idKey] = cal.id; S.gcal[mapKey] = {};
  return cal.id;
}
const ensureCalendar = S => ensureNamed(S, 'calendarId', 'map', '@me Study', 'Study sessions planned by @me');

const hashOf = b => `${b.date}|${b.s}|${b.e}|${b.title}|${b.status}`;
function eventBody(b, it) {
  const done = b.status === 'done';
  return {
    summary: `${done ? '✅' : '📚'} ${b.title}`,
    description: `${STYPES[b.stype] ? `${STYPES[b.stype].icon} ${STYPES[b.stype].label}\n` : ''}${b.focus || ''}${STYPES[b.stype] && b.stype !== 'project' && b.stype !== 'writing' ? `\n${STYPES[b.stype].how}` : ''}${it ? `\nFor: ${it.course} ${it.name}` : ''}\n\nPlanned by @me`,
    start: { dateTime: dateAt(b.date, b.s).toISOString(), timeZone: TZ },
    end: { dateTime: dateAt(b.date, b.e).toISOString(), timeZone: TZ },
    reminders: { useDefault: false, overrides: done ? [] : [{ method: 'popup', minutes: 10 }] },
    extendedProperties: { private: { atmeBlock: b.id } }
  };
}

// Makes the "@me Study" calendar match @me's plan: creates new sessions, updates moved ones, deletes removed ones.
// Because it diffs against state, undo and replanning automatically fix the calendar too.
export async function syncPlan(S, itemById) {
  const calId = await ensureCalendar(S);
  const cal = encodeURIComponent(calId);
  const floor = addDays(today(), -14);
  const want = S.plan.filter(b => (b.status === 'planned' || b.status === 'done') && b.date >= floor);
  const wantIds = new Set(want.map(b => b.id));
  const stats = { created: 0, updated: 0, deleted: 0 };
  for (const b of want) {
    const h = hashOf(b), cur = S.gcal.map[b.id];
    if (cur && cur.hash === h) continue;
    const body = eventBody(b, itemById(b.itemId));
    if (cur) {
      try { await api(`/calendars/${cal}/events/${cur.eventId}`, { method: 'PATCH', body }); S.gcal.map[b.id] = { eventId: cur.eventId, hash: h }; stats.updated++; continue; }
      catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
    }
    const ev = await api(`/calendars/${cal}/events`, { method: 'POST', body });
    S.gcal.map[b.id] = { eventId: ev.id, hash: h }; stats.created++;
  }
  for (const [bid, m] of Object.entries(S.gcal.map)) {
    if (wantIds.has(bid)) continue;
    const b = S.plan.find(x => x.id === bid);
    if (b && b.date < floor) continue;   // leave old history alone
    try { await api(`/calendars/${cal}/events/${m.eventId}`, { method: 'DELETE' }); } catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
    delete S.gcal.map[bid]; stats.deleted++;
  }
  return stats;
}

// Puts weekly class meetings on their own "@me Classes" calendar as repeating events until the semester ends.
// Turning the setting off removes them again.
export async function syncClasses(S) {
  S.gcal.classMap = S.gcal.classMap || {};
  const want = S.extras.classCal ? S.routine.filter(r => r.course) : [];
  const stats = { created: 0, updated: 0, deleted: 0 };
  if (!want.length && !Object.keys(S.gcal.classMap).length) return stats;
  const calId = want.length ? await ensureNamed(S, 'classCalId', 'classMap', '@me Classes', 'Your class schedule, added by @me') : S.gcal.classCalId;
  if (!calId) return stats;
  const cal = encodeURIComponent(calId);
  const from = S.term?.start && S.term.start > today() ? S.term.start : today();
  const until = S.term?.end || addDays(today(), 112);
  const wantIds = new Set(want.map(r => r.id));
  for (const r of want) {
    let first = from; for (let i = 0; i < 7 && !r.days.includes(wkey(first)); i++) first = addDays(first, 1);
    if (first > until) continue;
    const course = S.courses.find(c => c.code === r.course);
    const skip = [...new Set([...(course?.noClass || []), ...(r.skip || []), ...(S.holidays || [])])].filter(d => d >= first && d <= until && r.days.includes(wkey(d))).sort();
    const hm = h => `${pad(Math.floor(h))}${pad(Math.round((h % 1) * 60))}00`;
    const lectures = /lab|recitation|discussion/i.test(r.title) ? [] : (course?.lectures || []).filter(l => l.date >= today());
    const hash = `${r.days.join()}|${r.s}|${r.e}|${r.title}|${first}|${until}|${skip.join()}|${lectures.length}`, cur = S.gcal.classMap[r.id];
    if (cur && cur.hash === hash) continue;
    const body = {
      summary: r.title,
      description: lectures.length ? `Upcoming lectures:\n${lectures.slice(0, 20).map(l => `${dLabel(l.date)}: ${l.topic}`).join('\n')}\n\nAdded by @me` : 'Class time added by @me',
      start: { dateTime: dateAt(first, r.s).toISOString(), timeZone: TZ },
      end: { dateTime: dateAt(first, r.e).toISOString(), timeZone: TZ },
      recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${r.days.map(d => d.slice(0, 2).toUpperCase()).join(',')};UNTIL=${until.replace(/-/g, '')}T235959Z`,
        ...(skip.length ? [`EXDATE;TZID=${TZ}:${skip.map(d => `${d.replace(/-/g, '')}T${hm(r.s)}`).join(',')}`] : [])],
      reminders: { useDefault: false, overrides: [] },
      extendedProperties: { private: { atmeRoutine: r.id } }
    };
    if (cur) {
      try { await api(`/calendars/${cal}/events/${cur.eventId}`, { method: 'PUT', body }); S.gcal.classMap[r.id] = { eventId: cur.eventId, hash }; stats.updated++; continue; }
      catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
    }
    const ev = await api(`/calendars/${cal}/events`, { method: 'POST', body });
    S.gcal.classMap[r.id] = { eventId: ev.id, hash }; stats.created++;
  }
  for (const [rid, m] of Object.entries(S.gcal.classMap)) {
    if (wantIds.has(rid)) continue;
    try { await api(`/calendars/${cal}/events/${m.eventId}`, { method: 'DELETE' }); } catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
    delete S.gcal.classMap[rid]; stats.deleted++;
  }
  return stats;
}

// Puts every exam, quiz, and assignment on its own "@me Deadlines" calendar, with reminders.
// Exams remind you a day and an hour before; assignments the afternoon before they're due.
export async function syncDeadlines(S) {
  S.gcal.dueMap = S.gcal.dueMap || {};
  const floor = addDays(today(), -1);
  const want = S.extras.dueCal ? S.items.filter(i => i.status !== 'cancelled' && i.date >= floor) : [];
  const stats = { created: 0, updated: 0, deleted: 0 };
  if (!want.length && !Object.keys(S.gcal.dueMap).length) return stats;
  const calId = want.length ? await ensureNamed(S, 'dueCalId', 'dueMap', '@me Deadlines', 'Exams, quizzes, and assignments, added by @me') : S.gcal.dueCalId;
  if (!calId) return stats;
  const cal = encodeURIComponent(calId), wantIds = new Set(want.map(i => i.id));
  for (const it of want) {
    const skip = new Set(S.skipTopics?.[it.course] || []);
    const topics = (it.topics || []).filter(t => !skip.has(t) && t !== 'Everything');
    const icon = it.type === 'exam' ? '🎯' : it.type === 'quiz' ? '✏️' : '📝';
    // Exams during class fill the whole class period, matching the @me calendar.
    const span = it.type === 'exam' ? createPlanner(S).examSpan(it) : null;
    const timed = span ? true : it.time != null;
    const label = it.type === 'assignment' ? `Due${timed ? ' ' + fmt(it.time) : ''}: ` : '';
    const start = span ? span.s : it.type === 'assignment' ? Math.max(0, (it.time ?? 0) - 0.5) : it.time;
    const end = span ? Math.min(24, span.e) : it.type === 'assignment' ? it.time : Math.min(24, (it.time ?? 0) + (it.dur || 0.5));
    const body = {
      summary: `${icon} ${label}${it.course} ${it.name}${it.estimated ? ' (estimated)' : ''}`,
      description: [it.weight ? `Worth ${it.weight}% of your grade` : '', topics.length ? `Covers: ${topics.join(', ')}` : '',
        it.estimated ? 'Date estimated from an older syllabus. Check with your professor.' : '', 'Added by @me'].filter(Boolean).join('\n'),
      ...(timed ? { start: { dateTime: dateAt(it.date, start).toISOString(), timeZone: TZ }, end: { dateTime: dateAt(it.date, end).toISOString(), timeZone: TZ } }
               : { start: { date: it.date }, end: { date: addDays(it.date, 1) }, transparency: 'transparent' }),
      reminders: { useDefault: false, overrides: it.type === 'exam' ? [{ method: 'popup', minutes: 1440 }, { method: 'popup', minutes: 60 }] : timed ? [{ method: 'popup', minutes: 120 }] : [{ method: 'popup', minutes: 600 }] },
      extendedProperties: { private: { atmeItem: it.id } }
    };
    const hash = JSON.stringify([body.summary, body.start, body.end, body.description]), cur = S.gcal.dueMap[it.id];
    if (cur && cur.hash === hash) continue;
    if (cur) {
      try { await api(`/calendars/${cal}/events/${cur.eventId}`, { method: 'PUT', body }); S.gcal.dueMap[it.id] = { eventId: cur.eventId, hash }; stats.updated++; continue; }
      catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
    }
    const ev = await api(`/calendars/${cal}/events`, { method: 'POST', body });
    S.gcal.dueMap[it.id] = { eventId: ev.id, hash }; stats.created++;
  }
  for (const [iid, m] of Object.entries(S.gcal.dueMap)) {
    if (wantIds.has(iid)) continue;
    try { await api(`/calendars/${cal}/events/${m.eventId}`, { method: 'DELETE' }); } catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
    delete S.gcal.dueMap[iid]; stats.deleted++;
  }
  return stats;
}

export const calendarUrl = () => 'https://calendar.google.com/calendar/r/week';
