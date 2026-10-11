import { loadState, saveState, loadSettings } from './lib/store.js';
import { createPlanner, START } from './lib/planner.js';
import { ai, aiJSON, hasKey, provider, providerName } from './lib/ai.js';
import * as gcal from './lib/gcal.js';
import * as canvas from './lib/canvas.js';
import { BANK } from './lib/sample.js';
import { docxToText, isDocx, pptxToText, isPptx } from './lib/docx.js';
import { KINDS, autoTopics, addMaterial, removeMaterial, materialsFor, contextFor, notesQuiz } from './lib/materials.js';
import { readSyllabusText } from './lib/textsyl.js';
import { csQuiz, csPractice, csWrite } from './lib/csbank.js';
import {
  pad, iso, fromIso, addDays, today, nowH, WK, DAYNAME, wkey, isWeekday, nextWeekday, mondayOf, dayDiff, dLabel, dShort, dWeekday,
  fmt, parseHM, toHM, relDay, when, mins, hrs, tod, daysTxt, esc, uid, sleep, TZ, shortName, SITES
} from './lib/util.js';

const H = 64, VSTART = 7;   // pixels per hour, and the first hour shown on the calendar
// Crash protection: count starts that never finished. Two in a row means safe mode, which skips
// Google, Canvas, and background work until the student turns it off.
// A normal close or reload resets the count (pagehide fires); a crash never gets that chance.
const BOOT_KEY = 'atmeBootFails';
const bootFails = Number(localStorage.getItem(BOOT_KEY) || 0);
const SAFE = bootFails >= 2 || new URLSearchParams(location.search).has('safe');
localStorage.setItem(BOOT_KEY, String(bootFails + 1));
addEventListener('pagehide', () => localStorage.setItem(BOOT_KEY, '0'));
await chrome.storage.local.set({ 'atme:safe': SAFE });
const S = await loadState();
const P = createPlanner(S);
const UI = { week: mondayOf(isWeekday(today()) ? today() : nextWeekday(today())), busy: false, inSession: false, nextEl: null,
  hist: [], undoAfter: false, reviewShown: false, google: false, canvasOk: false, aiOk: false, aiName: 'Gemini', syncing: false, timer: null };
const { active, liveItems, itemById, nextExam, eventsOn, cutoff, gaps, findSlot, studyMinsOn, weekdaysBetween, lastDayFor, blockFor } = P;
const $ = id => document.getElementById(id);

/* ---------- persistence + Google Calendar sync ---------- */
let saveT = null, syncT = null;
function persist() { clearTimeout(saveT); saveT = setTimeout(() => saveState(S, 'app'), 250); }
function queueSync() {
  if (!UI.google || (!S.prefs && !S.extras.classCal && !S.extras.dueCal)) return;
  clearTimeout(syncT); syncT = setTimeout(runSync, 1200);
}
async function runSync(show) {
  if (!UI.google || UI.syncing) return;
  UI.syncing = true; renderStatus();
  try {
    const st = await gcal.syncPlan(S, itemById);
    const cl = await gcal.syncClasses(S);
    const dl = await gcal.syncDeadlines(S);
    await saveState(S, 'app');
    const n = st.created + st.updated + st.deleted;
    if (n || show) logTool('gcal.sync', '"@me Study" calendar', `${st.created} added, ${st.updated} updated, ${st.deleted} removed`);
    if (dl.created + dl.updated + dl.deleted) logTool('gcal.sync', '"@me Deadlines" calendar', `${dl.created} deadlines added, ${dl.updated} updated, ${dl.deleted} removed`);
    if (cl.created + cl.updated + cl.deleted) logTool('gcal.sync', '"@me Classes" calendar', `${cl.created} class times added, ${cl.updated} updated, ${cl.deleted} removed`);
  } catch (e) {
    logTool('gcal.sync', 'Google Calendar', `couldn't sync: ${e.message}`, true);
  } finally { UI.syncing = false; renderStatus(); }
}
// Reads your Google Calendar. Quiet mode is for the background check every couple of minutes:
// it only speaks up when you've added something new, and moves study sessions that now clash.
async function refreshBusy(force, quiet) {
  if (!UI.google) return false;
  if (!force && Date.now() - (S.gbusyAt || 0) < 10 * 60e3) return true;
  const prev = S.gevents;
  try {
    const r = await gcal.refreshEvents(S);
    if (!quiet) await tool(r.mode === 'events' ? 'gcal.events' : 'gcal.freebusy', 'your Google Calendar', r.mode === 'events' ? `${r.count} event${r.count !== 1 ? 's' : ''} in the next 5 weeks` : `${r.count} busy blocks (reconnect Google to see event names)`, 150);
    const added = prev && S.gevents ? gcal.newEvents(prev, S.gevents).filter(x => x.date >= today()) : [];
    if (quiet && added.length && started) logTool('gcal.watch', 'Google Calendar', `new: ${added.slice(0, 3).map(x => `${x.title} (${dLabel(x.date)}${x.allDay ? '' : ' ' + fmt(x.s)})`).join(', ')}`);
    if (quiet && S.prefs && S.plan.some(b => b.status === 'planned')) {
      const snap = snapshot(), c = P.resolveConflicts();
      if (c.moved.length || c.dropped.length) {
        const what = added.find(x => !x.allDay);
        const summary = `${what ? `"${what.title}" on ${dLabel(what.date)} overlapped your study time, so ` : 'Your Google Calendar changed, so '}I moved ${c.moved.length} session${c.moved.length !== 1 ? 's' : ''}${c.dropped.length ? ` and dropped ${c.dropped.length} that no longer fit` : ''}.${c.moved[0] ? ` ${c.moved[0].title} is now ${when(c.moved[0])}.` : ''}`;
        commitUndo(snap, 'Moved for a new event');
        raiseAlert(summary, c.moved);
      }
    }
    return true;
  } catch (e) { if (!quiet) logTool('gcal.events', 'Google Calendar', `couldn't read your calendar: ${e.message}`, true); return false; }
}

/* ---------- status chips ---------- */
async function checkConnections() {
  const st = await loadSettings();
  UI.provider = await provider(); UI.aiName = providerName(UI.provider); UI.aiOk = await hasKey();
  UI.google = SAFE ? false : await gcal.isConnected();
  UI.canvasOk = !SAFE && !!(st.canvasDomain && st.canvasToken && await canvas.hasPermission(st.canvasDomain));
  renderStatus();
}
function renderStatus() {
  const set = (id, ok, label, warn) => { const el = $(id); el.className = 'chip-s ' + (ok ? 'ok' : warn ? 'warn' : ''); el.lastChild.textContent = label; };
  set('stAI', UI.aiOk, UI.aiOk ? 'AI: Gemini' : 'AI: add free key');
  set('stGoogle', UI.google, UI.syncing ? 'Syncing…' : UI.google ? 'Google Calendar' : 'Connect Google', !UI.google);
  set('stCanvas', UI.canvasOk, UI.canvasOk ? 'Canvas' : 'Canvas: not set');
}
$('stAI').onclick = () => chrome.runtime.openOptionsPage();
$('stCanvas').onclick = () => chrome.runtime.openOptionsPage();
$('settingsBtn').onclick = () => chrome.runtime.openOptionsPage();
$('stGoogle').onclick = () => connectGoogle();
async function connectGoogle() {
  if (SAFE) { toggle(true); msg('bot', 'Google is paused while @me is in safe mode. Turn safe mode off with the button at the top first.'); return; }
  if (UI.google) { window.open(gcal.calendarUrl(), '_blank'); return; }
  toggle(true);
  try {
    await gcal.connect(); UI.google = true; renderStatus();
    await tool('gcal.connect', 'Google sign-in', 'connected', 200);
    msg('bot', 'Connected to Google Calendar! I\'ll plan around your existing events and put study sessions on a separate "@me Study" calendar, so your main calendar stays clean.');
    await refreshBusy(true); renderAll();
    setTimeout(() => offerGoogleExtras(), 300);
    if (S.plan.length) await runSync(true);
  } catch (e) {
    msg('bot', esc(`I couldn't connect to Google: ${e.message}. Check that the OAuth client ID in manifest.json is set up (see the README).`));
  }
}

/* ---------- rendering ---------- */
function setStep(n) { S.step = n; document.querySelectorAll('#steps li').forEach(li => { const i = +li.dataset.s; li.className = i < n ? 'done' : i === n ? 'on' : ''; }); }
function setAI(mode) { $('ai').className = 'ai ' + mode; $('ai').querySelector('span').textContent = mode === 'live' ? `${UI.aiName} answered` : 'Offline fallback'; }
// Monday to Friday, plus Saturday and/or Sunday when weekend studying is on.
const weekDates = () => [0, 1, 2, 3, 4, ...(['sat', 'both'].includes(S.extras.weekends) ? [5] : []), ...(['sun', 'both'].includes(S.extras.weekends) ? [6] : [])].map(i => addDays(UI.week, i));
function buildCal() {
  const ds = weekDates(), T = today();
  $('wkLabel').textContent = `${dShort(ds[0])} to ${dShort(ds.at(-1))}${UI.week === mondayOf(T) ? ' (this week)' : ''}`;
  let h = '<div class="dh corner"></div>' + ds.map(d => {
    const dues = liveItems().filter(i => i.date === d && !(i.type === 'exam' && P.examSpan(i)));
    const allDay = P.allDayOn(d);
    return `<div class="dh${d === T ? ' today' : ''}">${DAYNAME[wkey(d)]}<b>${fromIso(d).getDate()}</b><div class="dues">${allDay.map(x => `<span class="due gday" title="${esc(x.title)} (Google Calendar)">📅 ${esc(x.title)}</span>`).join('')}${dues.map(i => `<span class="due${i.type === 'exam' ? ' exam' : ''}" title="${esc(i.course + ' ' + i.name)}">${i.type === 'quiz' ? (/^quiz/i.test(i.name) ? '' : 'Quiz: ') : 'Due: '}${esc(i.name)}${i.type === 'quiz' && i.time != null ? ' at ' + fmt(i.time) : ''}</span>`).join('')}</div></div>`;
  }).join('');
  h += '<div class="hrs">'; for (let i = VSTART + 1; i <= 24; i++) h += `<div style="top:${(i - VSTART) * H}px">${i === 12 ? '12p' : i === 24 ? '12a' : i > 12 ? (i - 12) + 'p' : i + 'a'}</div>`;
  h += '</div>' + ds.map(d => `<div class="col" id="col-${d}"></div>`).join('');
  const cal = $('cal'); cal.style.gridTemplateColumns = `44px repeat(${ds.length},minmax(0,1fr))`; cal.style.setProperty('--hh', H + 'px'); cal.style.setProperty('--colh', (24 - VSTART) * H + 'px');
  cal.innerHTML = h;
  const NH = nowH();
  ds.forEach(d => {
    eventsOn(d).forEach(e => {
      const skip = e.topic && e.rid && P.isSkipped(S.routine.find(r => r.id === e.rid)?.course, e.topic);
      const line = e.topic ? `<span class="tp${skip ? ' skip' : ''}" title="${skip ? 'Marked not important, so there\'s no prep for it' : 'Lecture topic'}">📖 ${esc(e.topic)}${skip ? ' · no prep' : ''}</span>` : e.recap ? `<span class="tp" title="Recaps the most recent lecture">↺ Recap: ${esc(e.recap)}</span>` : '';
      const ex = e.kind === 'exam' ? itemById(e.itemId) : null;
      const exLine = ex?.topics?.length ? `<span class="tp" title="${esc(ex.topics.join('\n'))}">📖 Covers ${ex.topics.length} topic${ex.topics.length > 1 ? 's' : ''}: ${esc(ex.topics.slice(0, 3).join(', '))}${ex.topics.length > 3 ? '…' : ''}</span>` : '';
      const el = place(d, e.s, e.e, `<b>${esc(e.base || e.title)}</b>${fmt(e.s)}${e.kind === 'gcal' ? ' · Google' : ''}${line}${exLine}`, e.kind === 'exam' ? 'exam' : e.kind === 'gcal' ? 'cls gev' : 'cls');
      if (el) addX(el, { ...e, date: d }, e.base || e.title);
    });
    S.plan.filter(b => active(b) && b.date === d).forEach(drawBlock);
    if (d === T && NH >= VSTART && NH <= 24) { const n = document.createElement('div'); n.className = 'nowline'; n.style.top = (NH - VSTART) * H + 'px'; n.title = 'Now'; $('col-' + d).appendChild(n); }
  });
  $('emptyCal').style.display = S.courses.length || S.routine.length || Object.keys(S.gevents || S.gbusy).length ? 'none' : 'block';
  // Jump to a useful spot the first time a week is shown: an hour before now, or 8 AM.
  if (UI.scrolledWeek !== UI.week) {
    UI.scrolledWeek = UI.week;
    const target = UI.week === mondayOf(T) && NH > 9 && NH < 22 ? NH - 1 : 8;
    $('calwrap').scrollTop = Math.max(0, (target - VSTART) * H);
  }
}
function place(date, s, e, html, cls, id) {
  const col = $('col-' + date); if (!col) return null;
  if (id && $(id)) $(id).remove();
  const el = document.createElement('div'); el.className = 'ev ' + cls + (e - s < 0.9 ? ' short' : ''); el.innerHTML = html;
  el.style.top = (Math.max(s, VSTART) - VSTART) * H + 'px'; el.style.height = Math.max(20, (e - Math.max(s, VSTART)) * H - 3) + 'px'; if (id) el.id = id;
  el.dataset.s = s; el.dataset.e = e; col.appendChild(el); layoutCol(col); return el;
}
function layoutCol(col) {
  const evs = [...col.querySelectorAll('.ev')].map(el => ({ el, s: +el.dataset.s, e: +el.dataset.e })).sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [], end = -1;
  const flush = () => {
    const lanes = []; cluster.forEach(x => { let l = lanes.findIndex(z => z <= x.s + 1e-6); if (l < 0) { l = lanes.length; lanes.push(0); } lanes[l] = x.e; x.l = l; });
    cluster.forEach(x => { const n = lanes.length; x.el.style.left = `calc(${x.l / n * 100}% + 3px)`; x.el.style.right = 'auto'; x.el.style.width = `calc(${100 / n}% - 6px)`; }); cluster = [];
  };
  for (const x of evs) { if (x.s >= end - 1e-6 && cluster.length) flush(); cluster.push(x); end = Math.max(end, x.e); }
  if (cluster.length) flush();
}
// Marks a topic "not important" (or important again) and rebuilds prep for the exams and quizzes that cover it.
async function setTopicImportance(course, topic, important) {
  if (!course || !topic) return false;
  const cur = new Set(S.skipTopics?.[course] || []);
  if (important ? !cur.has(topic) : cur.has(topic)) return false;
  important ? cur.delete(topic) : cur.add(topic);
  S.skipTopics = { ...(S.skipTopics || {}), [course]: [...cur] };
  const T = today();
  const affected = liveItems().filter(i => i.course === course && i.type !== 'assignment' && i.date >= T && (i.topics || []).includes(topic));
  const ids = affected.map(i => i.id);
  let before = 0, after = 0;
  if (S.prefs && ids.length) {
    S.plan.forEach(b => { if (b.status === 'planned' && b.date >= T && ids.includes(b.itemId)) { b.status = 'removed'; before++; } });
    after = P.buildPlan(ids).created.length;
  }
  if (!important) Object.keys(S.srs).forEach(k => { if (k.endsWith('|' + topic) && ids.some(id => k.startsWith(id + '|'))) delete S.srs[k]; });
  renderAll();
  const names = affected.map(i => shortName(i)).join(' and ');
  logTool('topics.priority', `${course}: ${topic}`, important ? 'important again' : 'not important, no prep');
  msg('bot', esc(important
    ? `${topic} is back on the study list.${ids.length && S.prefs ? ` I rebuilt prep for ${names}: ${after} session${after !== 1 ? 's' : ''} now.` : ''}`
    : `Got it, ${topic} isn't important, so you don't need to prepare for it.${ids.length && S.prefs ? ` I rebuilt prep for ${names}${before !== after ? `, ${before} session${before !== 1 ? 's' : ''} down to ${after}` : ''}, so that time goes to the topics that matter.` : ''} Labs and projects still get work time, since they're graded.`));
  return true;
}

// Offers, once, to put class times and deadlines on Google Calendar too.
async function offerGoogleExtras(force) {
  if (!UI.google || !S.courses.length || (S.askedGcal && !force) || (S.extras.classCal && S.extras.dueCal)) return;
  S.askedGcal = true;
  const hasTimes = S.routine.some(r => r.course), nDue = liveItems().filter(i => i.date >= today()).length;
  msg('bot', esc(`Want your ${hasTimes ? 'class times' : ''}${hasTimes && nDue ? ' and ' : ''}${nDue ? `${nDue} deadlines` : ''} on Google Calendar too? They go on their own calendars, "@me Classes" and "@me Deadlines", so you can hide them anytime.`));
  const pick = await choose('Add to Google Calendar?', 'Class times repeat weekly until the semester ends and skip days off. Exams remind you a day before, assignments the afternoon before.',
    [{ label: 'Add classes and deadlines', value: 'both' }, ...(hasTimes ? [{ label: 'Just class times', value: 'classes' }] : []), ...(nDue ? [{ label: 'Just deadlines', value: 'due' }] : []), { label: 'Not now', value: 'no' }]);
  if (pick === 'no') { msg('bot', 'No problem. You can turn these on anytime under Study settings in the sidebar.'); persist(); return; }
  await withUndo('Google Calendar extras', () => applySettings({ classCal: pick === 'both' || pick === 'classes' || !!S.extras.classCal, dueCal: pick === 'both' || pick === 'due' || !!S.extras.dueCal }, true));
  clearTimeout(syncT); await runSync(true);
  msg('bot', 'Done! Check Google Calendar for the new calendars. Changes here keep syncing automatically.');
}

// Study time for a whole class: normal, light (about half the sessions, shorter), or none (deadlines only).
const LEVELS = { normal: 'Normal', light: 'Light', none: 'None' };
async function setCourseLevel(code, level) {
  const c = S.courses.find(x => x.code === code); if (!c || !LEVELS[level] || (c.priority || 'normal') === level) return false;
  c.priority = level;
  const T = today(), ids = liveItems().filter(i => i.course === code && i.date >= T).map(i => i.id);
  let before = 0, after = 0;
  if (S.prefs && ids.length) {
    S.plan.forEach(b => { if (b.status === 'planned' && b.date >= T && ids.includes(b.itemId)) { b.status = 'removed'; before++; } });
    after = P.buildPlan(ids).created.length;
  }
  renderAll(); logTool('classes.study_level', code, LEVELS[level]);
  remember(level === 'none' ? `${code} doesn't need study time` : level === 'light' ? `${code} only needs light study time` : `${code} gets normal study time`);
  msg('bot', esc(level === 'none' ? `Got it, no study sessions for ${code}. Its deadlines stay in Upcoming${S.extras.dueCal ? ' and on Google Calendar' : ''} so nothing sneaks up on you.${before ? ` I removed ${before} session${before > 1 ? 's' : ''}.` : ''}`
    : level === 'light' ? `${code} is on light study time: about half the sessions, and shorter ones.${S.prefs ? ` ${before} session${before !== 1 ? 's' : ''} became ${after}.` : ''}`
    : `${code} is back to normal study time.${S.prefs ? ` It has ${after} session${after !== 1 ? 's' : ''} now.` : ''}`));
  return true;
}
// "No prep" for one exam, quiz, or assignment. Its deadline stays, but it gets no study sessions.
async function setItemPrep(id, prep) {
  const it = itemById(id); if (!it || !prep === !!it.noPrep) return false;
  it.noPrep = !prep;
  let n = 0;
  if (!prep) S.plan.forEach(b => { if (b.status === 'planned' && b.itemId === id) { b.status = 'removed'; n++; } });
  else if (S.prefs) n = P.buildPlan([id]).created.length;
  renderAll(); logTool('tasks.prep', `${it.course} ${it.name}`, prep ? `${n} session${n !== 1 ? 's' : ''} planned` : 'no prep');
  msg('bot', esc(prep ? `${it.course} ${it.name} gets study time again: ${n} session${n !== 1 ? 's' : ''}.` : `No prep for ${it.course} ${it.name}.${n ? ` I removed ${n} session${n > 1 ? 's' : ''}.` : ''} It stays in Upcoming so you don't forget it's due.`));
  return true;
}
async function askCourseLevel(code) {
  const c = S.courses.find(x => x.code === code); if (!c) return;
  toggle(true);
  const v = await choose(`How much study time does ${code} need?`, `Right now: ${LEVELS[c.priority || 'normal']}. Gen-eds and easy classes usually do fine on Light or None.`,
    [{ label: 'Normal', value: 'normal' }, { label: 'Light: fewer, shorter sessions', value: 'light' }, { label: 'None: just track deadlines', value: 'none' }]);
  await withUndo(`${code} study time: ${LEVELS[v]}`, () => setCourseLevel(code, v));
  refreshNext();
}

// Course materials: slides, notes, study guides, and old exams make quizzes and practice exams match the class.
const fileB64 = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = () => rej(new Error('Could not read the file')); r.readAsDataURL(file); });
async function readMaterialFile(file, course) {
  if (isPptx(file)) return { text: await pptxToText(file), how: 'slides' };
  if (isDocx(file)) return { text: await docxToText(file), how: 'Word' };
  if (/\.(txt|md)$/i.test(file.name) || file.type.startsWith('text/')) return { text: await file.text(), how: 'text' };
  const pdf = /\.pdf$/i.test(file.name), img = file.type.startsWith('image/');
  if (!pdf && !img) throw new Error(`I can't read ${file.name}. Try PowerPoint, PDF, Word, text, or a photo.`);
  if (!UI.aiOk) throw new Error(`${pdf ? 'PDFs' : 'Photos'} need an AI key to read. Without one, use the PowerPoint or Word version, or paste the text.`);
  const content = [{ type: pdf ? 'document' : 'image', source: { type: 'base64', media_type: pdf ? 'application/pdf' : (file.type || 'image/png'), data: await fileB64(file) } },
    { type: 'text', text: 'Rewrite all of it as plain text.' }];
  const text = await ai(`These are course materials for ${course} (lecture slides, class notes, a study guide, or an exam). Rewrite ALL of the content as plain text, section by section. For slides, start each with "Slide N:" and its title. Keep every definition, example, formula, and code snippet (code as plain text). Don't summarize details away and don't add commentary. For handwriting, transcribe it as written.`, content, { maxTokens: 8000 });
  return { text, how: pdf ? 'PDF' : 'photo' };
}
function courseTopics(code) {
  const c = S.courses.find(x => x.code === code);
  return [...new Set([...(c?.lectures || []).map(l => l.topic), ...S.items.filter(i => i.course === code).flatMap(i => i.topics || [])])].filter(t => !['Everything', 'Overall'].includes(t));
}
function materialsCard(code, preset = {}) {
  toggle(true);
  if (!S.courses.length) { msg('bot', 'Add a class first, then you can add its slides and notes.'); return; }
  code = code || S.courses[0].code;
  const list = (S.materials || []).filter(m => m.course === code), topics = courseTopics(code);
  msg('bot', esc(`Add slides, notes, a study guide, or an old exam for ${code}, and I'll write quizzes and practice exams from them, in your professor's own terms and style.`));
  const c = card(`<h3>📎 Course materials</h3>
    ${S.courses.length > 1 ? `<label class="q" for="matCourse">Class</label><select class="field" id="matCourse">${S.courses.map(x => `<option value="${esc(x.code)}"${x.code === code ? ' selected' : ''}>${esc(x.code)}${x.name ? ' ' + esc(x.name) : ''}</option>`).join('')}</select>` : ''}
    <label class="q" for="matKind">What is it?</label>
    <select class="field" id="matKind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${k === (preset.kind || 'slides') ? ' selected' : ''}>${v}</option>`).join('')}</select>
    <p class="muted small" style="margin:10px 0 4px">Upload files: PowerPoint, PDF, Word, text, or a photo of your notes</p>
    <input type="file" class="field" multiple accept=".pptx,.pdf,.docx,.txt,.md,image/png,image/jpeg,image/webp" aria-label="Course material files">
    <p class="muted small" style="margin:10px 0 4px">Or paste notes:</p>
    <textarea class="field" rows="4" aria-label="Paste notes" placeholder="Paste lecture notes, a study guide, or practice questions"></textarea>
    ${topics.length ? `<div class="q">Which topics does it cover? Leave all off and I'll figure it out.</div><div class="chips multi">${topics.map(t => `<button class="chip" aria-pressed="${(preset.topics || []).includes(t)}" data-v="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
    <div class="btns"><button class="btn go">Add materials</button></div>
    ${list.length ? `<div class="q">Already added</div><ul class="slist mats">${list.map(m => `<li data-id="${m.id}"><span>${esc(m.name)}<small>${esc(KINDS[m.kind])}${m.topics.length ? ' · ' + esc(m.topics.join(', ')) : ' · all topics'}</small></span><button class="xs" data-del="${m.id}" aria-label="Remove ${esc(m.name)}">×</button></li>`).join('')}</ul>` : ''}`);
  c.querySelector('.chips.multi')?.addEventListener('click', e => { const b = e.target.closest('.chip'); if (b && !b.disabled) b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); });
  c.querySelector('#matCourse')?.addEventListener('change', e => { lock(c); materialsCard(e.target.value, preset); });
  c.querySelector('.mats')?.addEventListener('click', async e => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    const m = (S.materials || []).find(x => x.id === b.dataset.del); if (!m || !confirm(`Remove ${m.name}?`)) return;
    await removeMaterial(S, m.id); b.closest('li').remove(); renderAll(); msg('bot', esc(`Removed ${m.name}.`));
  });
  c.querySelector('.go').onclick = async () => {
    const files = [...c.querySelector('input[type=file]').files], pasted = c.querySelector('textarea').value.trim();
    if (!files.length && pasted.length < 40) { msg('bot', 'Pick a file or paste some notes first.'); return; }
    if (UI.busy) return;
    const course = c.querySelector('#matCourse')?.value || code, kind = c.querySelector('#matKind').value;
    const picked = [...c.querySelectorAll('.chips.multi .chip[aria-pressed="true"]')].map(b => b.dataset.v);
    lock(c); UI.busy = true; msg('user', esc(files.length ? `Add ${files.map(f => f.name).join(', ')}` : 'Add my pasted notes'));
    const th = msg('bot', '<span class="muted">Reading your materials…</span>');
    const added = [];
    try {
      const sources = [...files.map(f => ({ f })), ...(pasted.length >= 40 ? [{ text: pasted, name: `Pasted ${KINDS[kind].toLowerCase()}` }] : [])];
      for (const src of sources) {
        try {
          const r = src.f ? await readMaterialFile(src.f, course) : { text: src.text, how: 'text' };
          const name = src.name || src.f.name.replace(/\.[^.]+$/, '');
          const tags = picked.length ? picked : autoTopics(r.text, courseTopics(course));
          const m = await addMaterial(S, { course, name, kind, text: r.text, topics: tags });
          const slides = (r.text.match(/^Slide \d+:/gm) || []).length;
          logTool('materials.add', `${name} (${r.how})`, `${slides ? `${slides} slides` : `${Math.round(m.chars / 1000)}k characters`}, ${tags.length ? tags.join(', ') : 'all topics'}`);
          added.push(m);
        } catch (e) { msg('bot', esc(`${src.f ? src.f.name : 'Your notes'}: ${e.message}`)); }
      }
    } finally { th.remove(); UI.busy = false; }
    renderAll();
    if (added.length) {
      const tags = [...new Set(added.flatMap(m => m.topics))];
      msg('bot', esc(`Added ${added.map(m => m.name).join(', ')}. ${tags.length ? `Quizzes on ${tags.slice(0, 4).join(', ')}${tags.length > 4 ? ', and more' : ''} will come from ${added.length > 1 ? 'these' : 'it'} now` : `Every quiz for ${course} can use ${added.length > 1 ? 'these' : 'it'} now`}${added.some(m => m.kind === 'exam') ? ', and practice exams will copy that exam\'s style' : ''}.${UI.aiOk ? '' : ' Without an AI key, I\'ll make definition questions from your notes.'}`));
    }
  };
}

/* ---------- proficiency ---------- */
// Proficiency comes only from scored questions (session quizzes, practice sets, self-checks), never from self-ratings.
// Recent attempts count more, so the bar follows how you're doing now.
const SKIP_PROF = ['Everything', 'Overall', 'General', 'Key concepts', 'Lecture notes', 'Practice problems'];
const profKey = (course, topic) => `${course}|${topic}`;
function recordProf(course, topic, score, n, src) {
  if (!n || !course || !topic || SKIP_PROF.includes(topic)) return null;
  S.prof = S.prof || {};
  const k = profKey(course, topic), p = S.prof[k] || { correct: 0, total: 0, pct: null, hist: [] };
  const before = p.pct, pct = 100 * score / n, w = Math.min(0.75, 0.35 + n * 0.05);
  p.correct += score; p.total += n;
  p.pct = Math.round(before == null ? pct : before * (1 - w) + pct * w);
  p.hist = [...p.hist, { at: Date.now(), pct: Math.round(pct), after: p.pct, n, src }].slice(-12);
  S.prof[k] = p;
  return { before, after: p.pct };
}
const levelOfPct = pct => pct == null ? { name: 'Not tested', cls: 'none' } : pct >= 90 ? { name: 'Mastered', cls: 'master' } : pct >= 70 ? { name: 'Proficient', cls: 'good' } : pct >= 40 ? { name: 'Developing', cls: 'mid' } : { name: 'Beginner', cls: 'low' };
function profRows(code) {
  return P.keepTopics(code, courseTopics(code)).filter(t => !SKIP_PROF.includes(t)).map(t => ({ t, p: (S.prof || {})[profKey(code, t)] }));
}
function renderProficiency() {
  const el = $('prof');
  if (!S.courses.length) { el.hidden = true; return; }
  const code = (S.courses.find(c => c.code === UI.profCourse) || S.courses.find(c => c.code === nextExam()?.course) || S.courses[0]).code;
  UI.profCourse = code;
  const rows = profRows(code), tested = rows.filter(r => r.p?.pct != null);
  if (!rows.length && S.courses.length === 1) { el.hidden = true; return; }
  el.hidden = false;
  const overall = tested.length ? Math.round(tested.reduce((a, r) => a + r.p.pct, 0) / tested.length) : null, ol = levelOfPct(overall);
  const weakest = [...tested].sort((x, y) => x.p.pct - y.p.pct)[0];
  const trend = p => { const h = p?.hist || []; if (h.length < 2) return ''; const d = (h.at(-1).after ?? h.at(-1).pct) - (h.at(-2).after ?? h.at(-2).pct); return d ? `<span class="ptrend ${d > 0 ? 'up' : 'down'}" title="Change since your last check">${d > 0 ? '▲' : '▼'} ${Math.abs(d)}</span>` : '<span class="ptrend">–</span>'; };
  el.innerHTML = `<div class="prof-hd">
      <b>📊 Proficiency</b>
      ${S.courses.length > 1 ? `<span class="ptabs">${S.courses.map(c => `<button class="ptab${c.code === code ? ' on' : ''}" data-course="${esc(c.code)}">${esc(c.code)}</button>`).join('')}</span>` : `<span class="muted small">${esc(code)}</span>`}
      <span class="pall" title="Average of the topics you've tested"><span class="pbar mini"><i class="lv-${ol.cls}" style="width:${overall ?? 0}%"></i></span><b>${overall == null ? '–' : overall + '%'}</b><span class="plev lv-${ol.cls}">${ol.name}</span></span>
      <span class="muted small">${tested.length} of ${rows.length} topics tested${weakest && S.profCollapsed ? ` · weakest: ${esc(weakest.t)} (${weakest.p.pct}%)` : ''}</span>
      <span class="phd-r">${rows.length ? `<button class="tb" data-act="weak">🎯 ${tested.length ? 'Check my weakest' : 'Take a self-check'}</button>` : ''}<button class="xs" data-act="toggle" aria-label="${S.profCollapsed ? 'Show' : 'Hide'} proficiency" aria-expanded="${!S.profCollapsed}">${S.profCollapsed ? '▸' : '▾'}</button></span>
    </div>
    ${S.profCollapsed ? '' : rows.length ? `<div class="pgrid">${rows.map(({ t, p }) => { const l = levelOfPct(p?.pct); return `<div class="prow">
        <span class="pt" title="${esc(t)}">${esc(t)}</span>
        <span class="pbar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p?.pct ?? 0}" aria-label="${esc(t)} proficiency"><i class="lv-${l.cls}" style="width:${p?.pct ?? 0}%"></i></span>
        <span class="ppct">${p?.pct == null ? '–' : p.pct + '%'}</span>
        <span class="plev lv-${l.cls}">${l.name}</span>${trend(p)}
        <button class="link" data-check="${esc(t)}" title="${p ? `${Math.round(p.correct * 10) / 10} of ${p.total} right so far. ` : ''}Take a 5-question self-check">Check</button></div>`; }).join('')}</div>`
      : '<p class="muted small" style="margin:6px 0 0">Add a syllabus with lecture topics to track how you\'re doing on each one.</p>'}`;
}
$('prof').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.course) { UI.profCourse = b.dataset.course; renderProficiency(); return; }
  if (b.dataset.act === 'toggle') { S.profCollapsed = !S.profCollapsed; renderProficiency(); persist(); return; }
  if (UI.busy || UI.inSession) return;
  if (b.dataset.check) return selfCheck(UI.profCourse, b.dataset.check);
  if (b.dataset.act === 'weak') {
    const rows = profRows(UI.profCourse), untested = rows.find(r => r.p?.pct == null), tested = rows.filter(r => r.p?.pct != null).sort((x, y) => x.p.pct - y.p.pct);
    const pick = tested[0] && (tested[0].p.pct < 70 || !untested) ? tested[0] : untested || tested[0];
    if (pick) selfCheck(UI.profCourse, pick.t);
  }
});
// A quick 5-question test on one topic. Uses your notes for it if you have any.
async function selfCheck(course, topic) {
  toggle(true);
  if (!course || !topic) { msg('bot', 'Tell me which topic to check, like "/check recursion".'); return; }
  const item = liveItems().filter(i => i.course === course && i.date >= today() && i.type !== 'assignment' && (i.topics || []).includes(topic)).sort((x, y) => x.date.localeCompare(y.date))[0];
  const target = item || { id: `self:${course}`, course, name: `${topic} self-check`, type: 'quiz', date: today(), topics: [topic], self: true };
  msg('user', esc(`Self-check: ${topic}`));
  const src = materialsFor(S, course, [topic]).length ? 'notes' : 'topics';
  await runPractice(target, [topic], 5, src, '', false, { selfCheck: true, topic });
}
function findTopic(text, course) {
  const low = String(text || '').toLowerCase().trim(); if (!low) return null;
  const pool = (course ? [course] : S.courses.map(c => c.code)).flatMap(code => profRows(code).map(r => ({ code, t: r.t })));
  return pool.find(x => x.t.toLowerCase() === low) || pool.find(x => low.includes(x.t.toLowerCase())) || pool.find(x => x.t.toLowerCase().includes(low)) || null;
}

/* ---------- on-demand exam practice ---------- */
// Finds the exam or quiz the student means: one they named, or the next exam coming up.
function practiceTarget(hint = {}) {
  const T = today(), up = liveItems().filter(i => i.date >= T && i.type !== 'assignment').sort((x, y) => x.date.localeCompare(y.date));
  if (hint.id && itemById(hint.id)) return itemById(hint.id);
  const h = String(hint.name || '').toLowerCase();
  if (h) {
    const named = up.find(i => `${i.course} ${i.name}`.toLowerCase().includes(h)) || up.find(i => h.includes(i.name.toLowerCase().split(':')[0]));
    if (named) return named;
    if (/final/.test(h)) return up.find(i => /final/i.test(i.name)) || up.find(i => i.type === 'exam');
    if (/quiz/.test(h)) return up.find(i => i.type === 'quiz') || up[0];
    const course = S.courses.find(c => h.includes(c.code.toLowerCase()) || h.includes(c.code.split(' ')[0].toLowerCase()));
    if (course) return up.find(i => i.course === course.code && i.type === 'exam') || up.find(i => i.course === course.code);
  }
  return up.find(i => i.type === 'exam') || up[0];
}
function practiceCard(item, preset = {}) {
  toggle(true);
  if (!item) { msg('bot', 'I don\'t see an exam or quiz coming up. Add a syllabus, or tell me about it, like "I have a CS 0445 midterm on Oct 20".'); return; }
  const listed = P.keepTopics(item.course, (item.topics || []).filter(t => t !== 'Everything'));
  const all = listed.length ? listed : P.keepTopics(item.course, courseTopics(item.course)).slice(0, 12);
  const pre = new Set(preset.topics?.length ? preset.topics.filter(t => all.includes(t)) : listed.length ? listed : all.slice(0, 6));
  const saved = materialsFor(S, item.course, [...pre]);
  const source = preset.source || (saved.length ? 'notes' : 'topics'), count = preset.count || 10;
  msg('bot', esc(`Let's practice for ${item.course} ${item.name} on ${dLabel(item.date)}. I can write the questions from your notes and slides, or just from the topics.`));
  const c = card(`<h3>✏️ Practice for ${esc(item.course)} ${esc(shortName(item))}</h3>
    <p class="muted" style="margin:0">${dLabel(item.date)}${item.weight ? `, ${item.weight}% of your grade` : ''}</p>
    ${all.length ? `<div class="q">Topics to cover</div><div class="chips multi ptopics">${all.map(t => `<button class="chip" aria-pressed="${pre.has(t)}" data-v="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : '<p class="muted small">No topics listed yet, so questions will cover the course in general.</p>'}
    <div class="q">How many questions?</div>${chips('n', ['5', '10', '15'])}
    <div class="q">Where should the questions come from?</div>${chips('src', ['📎 My notes and slides', 'Just the topics'])}
    <div class="srcnotes" ${source === 'notes' ? '' : 'hidden'}>
      <p class="muted small mlist" style="margin:8px 0 4px"></p>
      <button class="link addfiles">📎 Add files (slides, notes, or an old exam)</button>
      <textarea class="field" rows="4" placeholder="Or paste notes for this practice, like a study guide or your own summary" style="margin-top:6px"></textarea>
      <label class="set" style="font-size:13px"><input type="checkbox" class="savepaste" checked> Save pasted notes for future quizzes</label>
    </div>
    <div class="btns"><button class="btn go">Start practice</button></div>`);
  const pick = chipGroup(c, p => { c.querySelector('.srcnotes').hidden = p.src !== '📎 My notes and slides'; });
  c.querySelector(`[data-k="n"] [data-v="${count}"]`)?.setAttribute('aria-pressed', 'true'); pick.n = String(count);
  const srcLabel = source === 'notes' ? '📎 My notes and slides' : 'Just the topics';
  c.querySelector(`[data-k="src"] [data-v="${srcLabel}"]`)?.setAttribute('aria-pressed', 'true'); pick.src = srcLabel;
  const chosenTopics = () => [...c.querySelectorAll('.ptopics .chip[aria-pressed="true"]')].map(b => b.dataset.v);
  const showSaved = () => { const m = materialsFor(S, item.course, chosenTopics()); c.querySelector('.mlist').textContent = m.length ? `Using: ${m.map(x => x.name).join(', ')}` : 'No notes saved for these topics yet. Add files or paste some below.'; };
  showSaved();
  c.querySelector('.ptopics')?.addEventListener('click', e => { const b = e.target.closest('.chip'); if (b && !b.disabled) { b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); showSaved(); } });
  c.querySelector('.addfiles').onclick = () => { materialsCard(item.course, { topics: chosenTopics(), kind: 'slides' }); msg('bot', 'Once they\'re added, scroll back up and hit Start practice.'); };
  // Refresh the "Using:" line after materials get added.
  const iv = setInterval(() => { if (!document.body.contains(c) || c.querySelector('.go').disabled) return clearInterval(iv); showSaved(); }, 1500);
  c.querySelector('.go').onclick = async () => {
    if (UI.busy) return;
    const topics = chosenTopics(), n = +pick.n || 10, src = pick.src === 'Just the topics' ? 'topics' : 'notes';
    const pasted = c.querySelector('textarea').value.trim(), save = c.querySelector('.savepaste').checked;
    lock(c); clearInterval(iv);
    msg('user', esc(`${n} questions on ${topics.length ? topics.join(', ') : 'everything'}, ${src === 'notes' ? 'from my notes' : 'from the topics'}`));
    await runPractice(item, topics.length ? topics : all, n, src, src === 'notes' ? pasted : '', save);
  };
}
async function runPractice(item, topics, count, source, pasted, savePasted, extra = {}) {
  UI.busy = true;
  const th = msg('bot', '<span class="muted">Writing your practice problems…</span>');
  let tempId = null;
  try {
    if (pasted && pasted.length >= 40) {
      const m = await addMaterial(S, { course: item.course, name: `Notes for ${shortName(item)}`, kind: 'notes', text: pasted, topics });
      if (savePasted) { logTool('materials.add', m.name, 'saved for future quizzes'); renderAll(); } else tempId = m.id;
    }
    let ctx = { text: '', used: [] };
    if (source === 'notes') {
      ctx = await contextFor(S, item.course, topics, 22000);
      if (!ctx.text) { msg('bot', 'I don\'t have notes for those topics yet, so I\'ll write the questions from the topics instead.'); source = 'topics'; }
    }
    const cs = P.isCS(item.course), course = S.courses.find(x => x.code === item.course);
    const lang = /python/i.test(`${course?.name} ${(course?.lectures || []).map(l => l.topic).join(' ')}`) ? 'Python' : /c\+\+/i.test(course?.name || '') ? 'C++' : 'Java';
    const nShort = count >= 10 ? 2 : 1;
    let qs = null, live = false;
    if (UI.aiOk) {
      try {
        const sys = `You write exam practice problems for a college student preparing for ${item.course}${course?.name ? ' (' + course.name + ')' : ''} ${item.name}. Return ONLY JSON: {"questions":[{"topic":string,"type":"mc"|"short","q":string,"code":string or null,"options":[4 strings],"answer":0-3,"model":string,"explain":string}]}. Exactly ${count} questions on these topics, spread across them: ${topics.join(', ')}. "topic" must be one of those. Exactly ${nShort} must be type "short" (free response, with a complete model answer in "model", under 500 characters); the rest are "mc" (4 options, one correct, "answer" is its index, vary its position). Go from warm-up to real exam difficulty. Every question must be factually correct.${cs ? ` This is a computer science course using ${lang}. Include code tracing (what it prints or returns), Big-O, and spot-the-bug questions with code in "code" (at most 12 lines, no markdown fences), and make the short questions "write a method that…" with model code.` : ''}${source === 'notes' ? ' Write every question from the course materials below: use their terminology, notation, examples, and code style, and stay within what they cover. If an old or practice exam is included, copy its style and difficulty. In "explain", say where the answer comes from (like the slide or section title).' : ' No course materials were given, so write the kind of questions a typical university course asks on these topics.'} "explain" under 160 characters.`;
        const p = await aiJSON(sys, `Exam: ${item.course} ${item.name} on ${item.date}.${ctx.text ? `\n\nCOURSE MATERIALS:\n${ctx.text}` : ''}`, { maxTokens: Math.min(7000, 800 + count * 380), schema: SCHEMA.practice });
        const ok = (p.questions || []).filter(x => typeof x.q === 'string' && (x.type === 'short' ? typeof x.model === 'string' && x.model.trim() : Array.isArray(x.options) && x.options.length === 4 && Number.isInteger(x.answer) && x.answer >= 0 && x.answer < 4))
          .slice(0, count).map(x => ({ ...x, type: x.type === 'short' ? 'short' : 'mc', topic: topics.includes(x.topic) ? x.topic : topics[0],
            code: typeof x.code === 'string' && x.code.trim() ? x.code.replace(/^```\w*\n?|```$/g, '').split('\n').slice(0, 14).join('\n').slice(0, 700) : null }));
        if (ok.length >= Math.min(3, count)) { qs = ok; live = true; }
      } catch (e) { logTool('practice.ai', 'AI', `didn't answer: ${e.message}`, true); }
    }
    if (!qs) {
      // Offline: definitions from your notes, the built-in CS questions, and free-response problems with model answers.
      qs = [];
      if (source === 'notes') qs.push(...((await notesQuiz(S, item.course, topics, Math.ceil(count * 0.6))) || []).map(q => ({ ...q, type: 'mc' })));
      if (cs) {
        const writes = csWrite(topics, nShort);
        qs.push(...csPractice(topics, Math.max(0, count - qs.length - writes.length)), ...writes);
      } else {
        for (const t of topics) for (const x of (BANK[t] || [])) if (qs.length < count) qs.push({ topic: t, type: 'mc', q: x.q, code: null, options: x.o, answer: x.a, explain: x.x });
      }
      qs = qs.slice(0, count);
    }
    th.remove(); setAI(live ? 'live' : 'fallback');
    if (!qs.length) { msg('bot', 'I couldn\'t write practice questions offline for these topics. Add your notes or slides, or connect an AI key in Settings, and try again.'); return; }
    if (!live && qs.length < count) msg('bot', esc(`Offline, I could make ${qs.length} question${qs.length > 1 ? 's' : ''}. Add an AI key in Settings for the full set.`));
    logTool('practice.build', `${item.course} ${shortName(item)}`, `${qs.length} questions${source === 'notes' && ctx.used.length ? `, from ${ctx.used.join(', ')}` : ', from the topics'}`);
    practiceSet(item, qs, { live, sources: source === 'notes' ? ctx.used : [], ...extra });
  } finally {
    UI.busy = false;
    if (tempId) await removeMaterial(S, tempId);
  }
}
// AI tutor helpers. "Grade my answer" compares a free-response answer to the model answer;
// "Explain it" walks through a missed question using the student's own course materials.
async function gradeAnswer(course, x, answer) {
  return aiJSON(`You grade a college student's free-response answer for ${course}. Compare it to the model answer. Count correct ideas even in different words, and don't penalize small syntax slips unless the question is about syntax. Return JSON: {"verdict":"Got it"|"Partly"|"Missed it","feedback":string}. Feedback: 1 to 3 short sentences, under 320 characters, saying specifically what's right and what's missing. Talk to the student directly.`,
    `Question: ${x.q}${x.code ? `\nCode:\n${x.code}` : ''}\n\nModel answer:\n${x.model}\n\nStudent's answer:\n${answer}`, { maxTokens: 600, schema: SCHEMA.grade });
}
async function explainMiss(course, topic, x, chosen) {
  const ctx = await contextFor(S, course, [topic], 6000);
  return (await ai(`You're a patient tutor for ${course}. A student missed a practice question. Explain step by step why the right answer is right${chosen >= 0 ? ' and why their choice is wrong' : ''}, in under 700 characters. Use plain text with short lines, no markdown headings. If course materials are given, use their terms and mention which slide or section to review.`,
    `Topic: ${topic}\nQuestion: ${x.q}${x.code ? `\nCode:\n${x.code}` : ''}\nOptions: ${x.options.map((o, i) => `${'ABCD'[i]}) ${o}`).join('  ')}\nCorrect: ${'ABCD'[x.answer]}) ${x.options[x.answer]}${chosen >= 0 ? `\nStudent chose: ${'ABCD'[chosen]}) ${x.options[chosen]}` : '\nStudent skipped it.'}${ctx.text ? `\n\nCOURSE MATERIALS:\n${ctx.text}` : ''}`, { maxTokens: 700 })).trim();
}
const aiTag = () => UI.provider === 'gemini' ? ' with Gemini' : '';
function addExplain(el, course, topic, x, chosen) {
  if (!UI.aiOk || !x.options) return;
  const b = document.createElement('button'); b.className = 'link aibtn'; b.type = 'button'; b.textContent = `✨ Explain it${aiTag()}`;
  b.onclick = async () => {
    b.disabled = true; b.textContent = 'Thinking…';
    try { const t = await explainMiss(course, topic, x, chosen); const p = document.createElement('div'); p.className = 'aiout'; p.textContent = t; b.replaceWith(p); setAI('live'); }
    catch (e) { b.disabled = false; b.textContent = `✨ Explain it${aiTag()}`; const m = document.createElement('div'); m.className = 'muted small'; m.textContent = `Couldn't explain that one: ${e.message}`; b.after(m); }
  };
  el.appendChild(b);
}

function practiceSet(item, qs, meta) {
  const c = card(`<h3>${meta.selfCheck ? `🎯 Self-check: ${esc(meta.topic)}` : `✏️ Practice: ${esc(item.course)} ${esc(shortName(item))}`}</h3>
    <p class="muted small" style="margin:0">${meta.sources.length ? `📎 Based on ${esc(meta.sources.slice(0, 3).join(', '))}` : 'Written from the topics'}${meta.live ? '' : ' (offline)'} · ${qs.length} questions</p>
    ${qs.map((x, i) => `<div class="qq pq" data-i="${i}"><p>${i + 1}. <span class="qtopic">${esc(x.topic)}</span> ${esc(x.q).replace(/\n/g, '<br>')}</p>
      ${x.code ? `<pre class="qcode"><code>${esc(x.code)}</code></pre>` : ''}
      ${x.type === 'mc' ? chips('q' + i, x.options) : `<textarea class="field" rows="4" placeholder="Your answer"></textarea>
        <div class="model" hidden><p class="muted small" style="margin:8px 0 4px">Model answer</p><pre class="qcode"><code>${esc(x.model)}</code></pre>
        <div class="q" style="margin-top:6px">How did you do?</div>${chips('s' + i, ['Got it', 'Partly', 'Missed it'])}</div>`}
      <div class="ex" hidden></div></div>`).join('')}
    <div class="btns"><button class="btn check">Check my answers</button><button class="btn ghost done" hidden disabled>See my results</button></div>`);
  c.querySelectorAll('.pq').forEach(q => q.querySelectorAll('[data-k^="q"] .chip').forEach((el, j) => el.dataset.v = String(j)));
  const pick = chipGroup(c, p => { if (!c.querySelector('.done').hidden) c.querySelector('.done').disabled = !qs.every((x, i) => x.type === 'mc' || p['s' + i]); });
  c.querySelector('.check').onclick = () => {
    c.querySelector('.check').disabled = true;
    qs.forEach((x, i) => {
      const el = c.querySelector(`.pq[data-i="${i}"]`), ex = el.querySelector('.ex');
      if (x.type === 'mc') {
        const ch = pick['q' + i] != null ? +pick['q' + i] : -1, ok = ch === x.answer;
        const cs = el.querySelectorAll('[data-k^="q"] .chip'); cs.forEach(z => { z.disabled = true; z.setAttribute('aria-pressed', 'false'); });
        cs[x.answer].classList.add('right'); if (ch >= 0 && !ok) cs[ch].classList.add('wrong');
        ex.hidden = false; ex.textContent = (ch < 0 ? 'Skipped. ' : ok ? 'Correct. ' : 'Not quite. ') + (x.explain || '');
        if (!ok) addExplain(ex, item.course, x.topic, x, ch);
      } else {
        const md = el.querySelector('.model'), ta = el.querySelector('textarea'); md.hidden = false; ta.disabled = true;
        if (UI.aiOk && ta.value.trim().length > 3) {
          const gb = document.createElement('button'); gb.className = 'link aibtn'; gb.type = 'button'; gb.textContent = `✨ Grade my answer${aiTag()}`;
          gb.onclick = async () => {
            gb.disabled = true; gb.textContent = 'Grading…';
            try {
              const g = await gradeAnswer(item.course, x, ta.value.trim());
              const fb = document.createElement('div'); fb.className = 'aiout'; fb.textContent = `${g.verdict}. ${g.feedback}`; gb.replaceWith(fb);
              md.querySelector(`[data-k="s${i}"] .chip[data-v="${['Got it', 'Partly', 'Missed it'].includes(g.verdict) ? g.verdict : 'Partly'}"]`)?.click();
              setAI('live');
            } catch (e) { gb.disabled = false; gb.textContent = `✨ Grade my answer${aiTag()}`; }
          };
          md.querySelector('.q').before(gb);
        }
      }
    });
    const hasShort = qs.some(x => x.type === 'short'), done = c.querySelector('.done');
    done.hidden = false; done.disabled = hasShort;
    if (hasShort) msg('bot', 'Check your free-response answers against the model answers, then rate yourself on each one.'); else done.click();
  };
  c.querySelector('.done').onclick = async () => {
    lock(c);
    const per = {}; let score = 0;
    qs.forEach((x, i) => {
      const pts = x.type === 'mc' ? (+pick['q' + i] === x.answer ? 1 : 0) : ({ 'Got it': 1, 'Partly': 0.5 }[pick['s' + i]] || 0);
      score += pts; (per[x.topic] = per[x.topic] || [0, 0])[0] += pts; per[x.topic][1]++;
    });
    const pct = Math.round(100 * score / qs.length);
    const moves = [];
    await withUndo(meta.selfCheck ? 'Self-check results' : 'Practice results', async () => {
      for (const [t, [s, n]] of Object.entries(per)) {
        // Exam readiness for every upcoming exam or quiz that covers this topic.
        const exams = [...new Set([...(item.self ? [] : [item]), ...liveItems().filter(i => i.course === item.course && i.date >= today() && i.type !== 'assignment' && (i.topics || []).includes(t))])];
        for (const ex of exams) {
          const k = `${ex.id}|${t}`, qc = 1 + 4 * s / n, prev = S.ready[k];
          S.ready[k] = Math.max(1, Math.min(5, Math.round(prev ? (prev + qc) / 2 : qc)));
          S.quiz[k] = `${Math.round(s * 10) / 10}/${n}`;
        }
        const m = recordProf(item.course, t, s, n, meta.selfCheck ? 'self-check' : 'practice'); if (m) moves.push({ t, ...m });
      }
      S.studied += qs.length * 2; remember(meta.selfCheck ? `Self-checked ${meta.topic}` : `Practiced for ${item.course} ${shortName(item)}`);
      UI.profCourse = item.course; renderAll();
    });
    if (moves.length) {
      const line = m => { const l = levelOfPct(m.after); return `${m.t}: ${m.before == null ? '' : `${m.before}% → `}${m.after}%, ${l.name}${m.before == null ? '' : m.after > m.before ? ` (up ${m.after - m.before})` : m.after < m.before ? ` (down ${m.before - m.after})` : ''}`; };
      msg('bot', esc(`📊 Proficiency: ${moves.map(line).join('; ')}.`));
      $('prof').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    const rows = Object.entries(per).map(([t, [s, n]]) => ({ t, s, n, f: s / n })).sort((x, y) => x.f - y.f);
    const weak = rows.filter(r => r.f < 0.6), strong = rows.filter(r => r.f >= 0.85);
    msg('bot', esc(`You scored ${Math.round(score * 10) / 10} out of ${qs.length} (${pct}%). ${pct >= 85 ? 'Exam-ready on this set 🔥' : pct >= 60 ? 'Solid, with a couple of spots to tighten up.' : 'Good thing we practiced. Now we know exactly what to work on.'}${strong.length ? ` Strongest: ${strong.map(r => r.t).join(', ')}.` : ''}${weak.length ? ` Needs work: ${weak.map(r => `${r.t} (${Math.round(r.s * 10) / 10}/${r.n})`).join(', ')}.` : ''} Your readiness meters are updated.`));
    if (meta.selfCheck) {
      const real = !item.self;
      const v = await choose('What next?', '', [{ label: `Check ${meta.topic} again`, value: 'again' }, ...(real && score / qs.length < 0.7 ? [{ label: `Add a review session for ${meta.topic}`, value: 'review' }] : []), { label: 'Done for now', value: 'done' }]);
      if (v === 'again') return selfCheck(item.course, meta.topic);
      if (v !== 'review') return;
    }
    if (!weak.length && !meta.selfCheck) return;
    const w = weak[0] || { t: meta.topic };
    if (meta.selfCheck) return addReviewFor(item, w.t);
    const v = await choose(`What next for ${w.t}?`, 'Your weakest topic from this set.', [
      { label: `Add a review session for ${w.t}`, value: 'review' },
      { label: `Practice ${w.t} more (5 questions)`, value: 'more' },
      { label: 'Done for now', value: 'done' }]);
    if (v === 'more') return practiceCard(item, { topics: [w.t], count: 5, source: meta.sources.length ? 'notes' : 'topics' });
    if (v === 'review') await addReviewFor(item, w.t);
  };
}
async function addReviewFor(item, topic) {
  const w = { t: topic };
  await withUndo(`Review: ${w.t}`, async () => {
      if (!S.prefs) { msg('bot', 'Finish setup first, then I can schedule reviews.'); return; }
      const last = P.lastDayFor(item); let placed = null;
      for (const d of weekdaysBetween(today(), last)) { if (studyMinsOn(d) + S.prefs.len > P.capFor(d)) continue; const sl = findSlot(d, S.prefs.len); if (sl) { placed = blockFor(item, d, sl, `Extra: ${w.t}`, [w.t], 'extra', `Practice showed ${w.t} needs work`); break; } }
      if (!placed) { msg('bot', esc(`There's no open time before ${shortName(item)} for another session. Try "Practice ${w.t} more" instead.`)); return; }
      placed.score = S.ready[`${item.id}|${w.t}`]; placed.stype = P.isCS(item.course) ? 'coding' : 'problems'; S.plan.push(placed); renderAll();
      msg('bot', esc(`Added a ${w.t} session ${when(placed)}.`));
  });
}

// Every block gets a small × that opens a menu of sensible ways to discard it.
function addX(el, meta, label) {
  if (!el || (meta.kind === 'exam' && !meta.itemId)) return;
  const x = document.createElement('button');
  x.className = 'evx'; x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', `Options to remove ${label}`);
  x.onclick = e => { e.stopPropagation(); evMenu(meta, el, label); };
  el.appendChild(x);
}
function evMenu(meta, el, label) {
  document.querySelector('.pop')?.remove();
  const day = dLabel(meta.date), r = meta.rid && S.routine.find(x => x.id === meta.rid);
  const opts = [];
  if (meta.kind === 'class' && r) {
    opts.push({ a: 'skip', t: `Skip this class on ${day}`, d: 'Just this once, like a canceled lecture' });
    opts.push({ a: 'dayoff', t: `Day off: no classes on ${day}`, d: 'For holidays and breaks. Removes every class that day' });
    opts.push({ a: 'weekly', t: 'Remove from every week', d: 'You dropped this section or it moved' });
    if (meta.topic) opts.push(P.isSkipped(r.course, meta.topic)
      ? { a: 'imp', t: `Mark "${meta.topic}" important again`, d: 'Bring back study time for it', topic: meta.topic, course: r.course }
      : { a: 'unimp', t: `Not important: no prep for "${meta.topic}"`, d: 'Drops it from study sessions, quizzes, and reviews', topic: meta.topic, course: r.course });
  } else if (meta.kind === 'busy' && r) {
    opts.push({ a: 'skip', t: `Skip on ${day}`, d: 'Just this once' });
    opts.push({ a: 'weekly', t: 'Remove from every week', d: '' });
  } else if (meta.kind === 'busy' && meta.oid) {
    opts.push({ a: 'oneoff', t: 'Remove this event', d: '' });
  } else if (meta.kind === 'gcal') {
    opts.push({ a: 'ignore', t: 'Ignore this for planning', d: 'It stays on your Google Calendar. @me just stops planning around it' });
    opts.push({ a: 'ignoreall', t: `Ignore every "${label}" event`, d: 'For repeating events, like a shift you don\'t study around' });
  } else if (meta.kind === 'exam') {
    opts.push({ a: 'cancel', t: 'Cancel this exam', d: 'Also removes its study sessions' });
  } else if (meta.kind === 'study') {
    opts.push({ a: 'remove', t: 'Remove this session', d: '' });
    opts.push({ a: 'move', t: 'Move it to another time', d: 'I\'ll find the next open slot before it\'s due' });
    const sb = S.plan.find(x => x.id === meta.bid), sit = sb && itemById(sb.itemId);
    if (sit) opts.push({ a: 'noprep', t: `No prep for ${shortName(sit)}`, d: 'Removes all its sessions. The deadline stays', item: sit.id });
    if (sit && P.levelOf(sit.course) === 'normal') opts.push({ a: 'light', t: `Less study time for ${sit.course}`, d: 'About half the sessions, and shorter', course: sit.course });
    if (sb && sit && sit.type !== 'assignment') realTopics(sb).filter(t => !P.isSkipped(sit.course, t)).slice(0, 3)
      .forEach(t => opts.push({ a: 'unimp', t: `"${t}" isn't important`, d: 'No prep for it. I\'ll rebuild this exam\'s sessions', topic: t, course: sit.course }));
  }
  if (!opts.length) return;
  const c = $('center').getBoundingClientRect(), rc = el.getBoundingClientRect();
  const pop = document.createElement('div'); pop.className = 'pop menu'; pop.setAttribute('role', 'menu'); pop.setAttribute('aria-label', `Options for ${label}`);
  pop.innerHTML = `<button class="x" aria-label="Close">×</button><h4>${esc(label)}</h4><p class="muted">${day}</p>
    ${opts.map((o, i) => `<button class="mi" role="menuitem" data-a="${o.a}" data-i="${i}"><b>${esc(o.t)}</b>${o.d ? `<small>${esc(o.d)}</small>` : ''}</button>`).join('')}`;
  $('center').appendChild(pop);
  let left = rc.right - c.left + 8; if (left + 300 > c.width) left = Math.max(8, rc.left - c.left - 298);
  pop.style.left = left + 'px'; let top = rc.top - c.top; const over = rc.top + pop.offsetHeight - (innerHeight - 12); if (over > 0) top -= over; pop.style.top = Math.max(8, top) + 'px';
  pop.querySelector('.x').onclick = () => pop.remove();
  pop.querySelector('.mi').focus();
  pop.addEventListener('click', async e => {
    const b = e.target.closest('.mi'); if (!b || UI.busy) return;
    pop.remove(); toggle(true);
    const o = opts[+b.dataset.i];
    if (o.a === 'noprep') { await withUndo(`No prep: ${itemById(o.item)?.name}`, () => setItemPrep(o.item, false)); refreshNext(); return; }
    if (o.a === 'light') { await withUndo(`${o.course} study time: Light`, () => setCourseLevel(o.course, 'light')); refreshNext(); return; }
    if (o.a === 'unimp' || o.a === 'imp') { await withUndo(o.a === 'unimp' ? `Not important: ${o.topic}` : `Important: ${o.topic}`, () => setTopicImportance(o.course, o.topic, o.a === 'imp')); refreshNext(); return; }
    await discard(b.dataset.a, meta, label);
    refreshNext();
  });
}
async function discard(action, meta, label) {
  const day = dLabel(meta.date), r = meta.rid && S.routine.find(x => x.id === meta.rid);
  const gNote = UI.google && S.extras.classCal ? ' Your Google class calendar will update too.' : '';
  if (action === 'skip' && r) return withUndo(`Skipped ${r.title}`, async () => { r.skip = [...new Set([...(r.skip || []), meta.date])]; renderAll(); msg('bot', esc(`Skipped ${r.title} on ${day}. That time is free now.${r.course ? gNote : ''}`)); });
  if (action === 'dayoff') return withUndo(`Day off ${day}`, async () => {
    S.holidays = [...new Set([...(S.holidays || []), meta.date])].sort(); renderAll();
    const n = S.routine.filter(x => x.course && x.days.includes(wkey(meta.date))).length;
    msg('bot', esc(`${day} is a day off: no classes${n ? ` (${n} class time${n > 1 ? 's' : ''} cleared)` : ''}. Your study sessions that day are still there in case you want to get ahead, and you can remove them with their × too.${gNote}`));
  });
  if (action === 'weekly' && r) return withUndo(`Removed ${r.title}`, async () => { S.routine = S.routine.filter(x => x.id !== r.id); renderAll(); msg('bot', esc(`Removed ${r.title} from every week.${r.course ? gNote : ''}`)); });
  if (action === 'oneoff') return withUndo(`Removed ${label}`, async () => { S.oneoff = S.oneoff.filter(o => o.id !== meta.oid); renderAll(); msg('bot', esc(`Removed ${label} on ${day}.`)); });
  if (action === 'ignoreall') return withUndo(`Ignored all ${label}`, async () => { S.ignoredG = [...new Set([...(S.ignoredG || []), 'title:' + label])]; renderAll(); msg('bot', esc(`Got it, I'll plan as if every "${label}" event isn't there. They stay on your Google Calendar.`)); });
  if (action === 'ignore') return withUndo(`Ignored ${label}`, async () => { S.ignoredG = [...new Set([...(S.ignoredG || []), meta.gid])]; renderAll(); msg('bot', esc(`Got it, I'll plan as if "${label}" on ${day} isn't there. It's still on your Google Calendar.`)); });
  if (action === 'cancel') {
    const it = itemById(meta.itemId); if (!it) return;
    if (!confirm(`Cancel ${it.course} ${it.name}?`)) return;
    return withUndo(`Canceled ${it.name}`, async () => {
      it.status = 'cancelled'; const gone = S.plan.filter(b => b.itemId === it.id && b.status === 'planned'); gone.forEach(b => b.status = 'removed');
      remember(`${it.course} ${it.name} was cancelled`); renderAll();
      msg('bot', esc(`Canceled ${it.course} ${it.name}${gone.length ? ` and its ${gone.length} study session${gone.length > 1 ? 's' : ''}` : ''}. Hit undo if that was a mistake.`));
    });
  }
  const b = meta.bid && S.plan.find(x => x.id === meta.bid && x.status === 'planned');
  if (!b) return;
  if (action === 'remove') return withUndo(`Removed ${b.title}`, async () => { b.status = 'removed'; renderAll(); msg('bot', esc(`Removed ${b.title} on ${day}.${UI.google ? ' It\'s gone from Google Calendar too.' : ''}`)); });
  if (action === 'move') return withUndo(`Moved ${b.title}`, async () => {
    const m = P.relocate(b);
    if (!m) { msg('bot', esc(`I couldn't find another open time for ${b.title} before it's due. You can still remove it with the ×.`)); return; }
    b.date = m.d; b.s = m.s.s; b.e = m.s.e; UI.week = mondayOf(b.date); renderAll(); msg('bot', esc(`Moved ${b.title} to ${when(b)}.`));
  });
}
function drawBlock(b) {
  if (!$('col-' + b.date)) { $(b.id)?.remove(); return; }
  const cls = 'study' + (S.fresh.includes(b.id) ? ' fresh' : '') + (b.kind === 'extra' ? ' extra' : '') + (b.kind === 'review' ? ' review' : '') + (b.kind === 'group' && b.status !== 'done' ? ' group' : '') + (b.status === 'done' ? ' done' : '');
  const cov = P.coverage(b);
  const covHtml = cov ? `<span class="tp" title="${esc(cov.detail)}">${cov.icon} ${esc(cov.text)}</span>` : '';
  const st = P.STYPES[P.stypeOf(b)];
  const stHtml = st && b.kind !== 'review' ? ` · <span title="${esc(st.label)}: ${esc(st.how)}">${st.icon} ${esc(st.label)}</span>` : '';
  const html = b.kind === 'review' ? `<b style="display:inline">${esc(b.title)}</b> ${fmt(b.s)}${covHtml && mins(b) >= 30 ? covHtml : ''}` : `<b>${esc(b.title)}</b>${fmt(b.s)} · ${mins(b)} min${stHtml}${covHtml}`;
  const el = place(b.date, b.s, b.e, html, cls, b.id);
  if (b.status === 'planned') addX(el, { kind: 'study', bid: b.id, date: b.date }, b.title);
  el.tabIndex = 0; el.setAttribute('role', 'button'); el.setAttribute('aria-label', `${b.title}, ${when(b)}. Show why this time`);
  el.onclick = e => { e.stopPropagation(); showWhy(b, el); };
  el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showWhy(b, el); } };
}
function renderCourses() {
  const meet = r => `<span class="mt">${esc((r.course && r.title.startsWith(r.course) ? r.title.slice(r.course.length).trim() : r.title) || 'class')} ${daysTxt(r.days)} ${fmt(r.s)} to ${fmt(r.e)}<button class="xs" data-del-r="${r.id}" aria-label="Remove ${esc(r.title)}">×</button></span>`;
  $('courses').innerHTML = (S.courses.length ? S.courses.map(c => {
    const m = S.routine.filter(r => r.course === c.code);
    return `<div class="course"><div class="crow"><b>${esc(c.code)}</b><button class="xs" data-del-c="${esc(c.code)}" aria-label="Remove ${esc(c.code)}" title="Remove class">×</button></div>
      <small>${esc(c.name || '')}${c.name ? '. ' : ''}From ${esc(c.source)}${(() => { const n = (c.lectures || []).find(l => l.date >= today()); return n ? `<br>Next lecture ${dLabel(n.date)}: ${esc(n.topic)}` : ''; })()}</small>
      <div class="mts">${m.length ? m.map(meet).join('') : '<span class="muted small">No class times yet</span>'}</div>
      <button class="link" data-add-r="${esc(c.code)}">＋ Add class times</button>
      <button class="link lvl lvl-${c.priority || 'normal'}" data-prio="${esc(c.code)}">Study time: ${LEVELS[c.priority || 'normal']}</button>
      <button class="link" data-mat="${esc(c.code)}">📎 Slides & notes${(S.materials || []).filter(m => m.course === c.code).length ? ` (${(S.materials || []).filter(m => m.course === c.code).length})` : ''}</button></div>`;
  }).join('') : '<p class="muted" style="margin:0">No classes yet.</p>')
    + (S.routine.filter(r => !r.course).length ? `<div class="course"><b>Other weekly stuff</b><div class="mts">${S.routine.filter(r => !r.course).map(r => `<span class="mt">${esc(r.title)} ${daysTxt(r.days)} ${fmt(r.s)} to ${fmt(r.e)}<button class="xs" data-del-r="${r.id}" aria-label="Remove ${esc(r.title)}">×</button></span>`).join('')}</div></div>` : '')
    + (S.courses.length ? `<button class="link" data-sched="1" style="margin-top:6px">📋 Import my whole class schedule</button>` : '')
    + (S.term?.end ? `<p class="hint">Semester ends ${dLabel(S.term.end)}</p>` : '');
}
$('alist').addEventListener('click', async e => {
  if (e.target.closest('button.moredue')) { UI.allDue = !UI.allDue; renderAssign(); return; }
  const st = e.target.closest('button.settime'); if (st) { askFinalTime(itemById(st.dataset.final)); return; }
  const pb = e.target.closest('button.pr-btn');
  if (pb) { practiceCard(itemById(pb.dataset.practice)); return; }
  const mb = e.target.closest('button.mt-btn');
  if (mb) { const it = itemById(mb.dataset.matItem); if (it) materialsCard(it.course, { topics: P.keepTopics(it.course, it.topics || []), kind: it.type === 'exam' ? 'slides' : 'notes' }); return; }
  const b = e.target.closest('button.np'); if (!b || UI.busy) return;
  const prep = b.dataset.prep === '1', it = itemById(b.dataset.np); if (!it) return;
  toggle(true); await withUndo(prep ? `Prep for ${it.name}` : `No prep: ${it.name}`, () => setItemPrep(it.id, prep)); refreshNext();
});
$('topics').addEventListener('click', async e => {
  const pr = e.target.closest('[data-practice]'); if (pr) { practiceCard(itemById(pr.dataset.practice)); return; }
  const b = e.target.closest('button.tg'); if (!b || UI.busy) return;
  const imp = b.dataset.imp === '1', topic = b.dataset.topic, course = b.dataset.course;
  toggle(true);
  await withUndo(imp ? `Important: ${topic}` : `Not important: ${topic}`, () => setTopicImportance(course, topic, imp));
  refreshNext();
});
$('courses').addEventListener('click', async e => {
  const t = e.target.closest('button'); if (!t || UI.busy) return;
  if (t.dataset.addR) return openClassTimes(t.dataset.addR);
  if (t.dataset.prio) return askCourseLevel(t.dataset.prio);
  if (t.dataset.mat) return materialsCard(t.dataset.mat);
  if (t.dataset.sched) { toggle(true); return scheduleCard(); }
  if (t.dataset.delR) {
    const r = S.routine.find(x => x.id === t.dataset.delR); if (!r) return;
    toggle(true); await withUndo(`Removed ${r.title}`, async () => { S.routine = S.routine.filter(x => x.id !== r.id); renderAll(); });
    msg('bot', esc(`Removed ${r.title}, ${daysTxt(r.days)} ${fmt(r.s)}.${S.extras.classCal && UI.google ? ' Google Calendar will update too.' : ''}`));
  }
  if (t.dataset.delC) {
    const code = t.dataset.delC;
    if (!confirm(`Remove ${code} and everything @me planned for it?`)) return;
    toggle(true); await withUndo(`Removed ${code}`, async () => { const n = P.removeCourse(code); renderAll(); msg('bot', esc(`Removed ${code} and its ${n} item${n !== 1 ? 's' : ''}. Hit undo if that was a mistake.`)); });
    refreshNext();
  }
});

// Canvas usually doesn't know when classes meet, so ask, offering the fastest option first.
function askForMissingTimes() {
  const missing = S.courses.filter(c => !S.routine.some(x => x.course === c.code)).map(c => c.code);
  if (!missing.length) return;
  msg('bot', esc(`Canvas doesn't tell me when ${missing.length > 1 ? 'these classes meet' : 'this class meets'}: ${missing.join(', ')}. The quickest fix is to paste or screenshot your class schedule from your school's registration site, and I'll add everything at once.`));
  const c = card(`<div class="btns" style="margin:0"><button class="btn" data-s="1">📋 Use my class schedule</button>${missing.map(code => `<button class="btn ghost" data-c="${esc(code)}">＋ ${esc(code)} by hand</button>`).join('')}</div>`);
  c.addEventListener('click', e => { const b = e.target.closest('button'); if (!b || UI.busy) return; if (b.dataset.s) { scheduleCard(); } else openClassTimes(b.dataset.c); });
  msg('bot', 'Or just type them, like "CALC 151 meets Tue/Thu 8:40-10am".');
}

/* ---------- import a whole class schedule (pasted text or a screenshot) ---------- */
const normCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function matchCourse(code, name) {
  const n = normCode(code), num = (String(code || '').match(/\d{3}[A-Z]?/i) || [])[0];
  return S.courses.find(c => normCode(c.code) === n)
    || S.courses.find(c => n && (normCode(c.code).includes(n) || n.includes(normCode(c.code))))
    || (num && S.courses.find(c => normCode(c.code).endsWith(num.toUpperCase()) && (!name || !c.name || c.name.toLowerCase().split(/\W+/).some(w => w.length > 3 && String(name).toLowerCase().includes(w)))))
    || (name && S.courses.find(c => c.name && c.name.toLowerCase() === String(name).toLowerCase()));
}
function scheduleCard(prefill = '') {
  msg('bot', 'Paste your schedule as text, or drop in a screenshot, PDF, or Word file of it. Your school\'s registration or student center page works great 📋');
  const c = card(`<h3>Import your class schedule</h3>
    <textarea class="field" rows="5" placeholder="e.g.\nCHEM 161 Lecture MWF 10:20-11:15\nCHEM 161 Lab Th 1:00-4:00 PM\nCALC 151 TTh 8:40-10:00 AM"></textarea>
    <p class="muted small" style="margin:8px 0 4px">Or upload a screenshot, PDF, or Word file:</p>
    <input type="file" class="field" accept="image/png,image/jpeg,image/webp,.pdf,.docx" aria-label="Schedule screenshot, PDF, or Word file">
    <div class="btns"><button class="btn go">Add class times</button><button class="btn ghost hand">Enter them by hand</button></div>`);
  if (prefill) c.querySelector('textarea').value = prefill;
  c.querySelector('.hand').onclick = () => { lock(c); openClassTimes(); };
  c.querySelector('.go').onclick = async () => {
    const text = c.querySelector('textarea').value.trim(), file = c.querySelector('input').files[0];
    if (!text && !file) return;
    if (UI.busy) return;
    let list = null;
    if (text && !file && !UI.aiOk) list = parseRoutine(text).filter(x => x.course).map(x => ({ code: x.course, days: x.days, s: x.s, e: x.e, label: /\blab\b/i.test(x.raw) ? 'lab' : /recitation/i.test(x.raw) ? 'recitation' : 'lecture' }));
    if (!list) {
      if (await needKey()) return;
      lock(c); UI.busy = true; msg('user', file ? esc(`Read ${file.name}`) : 'Here\'s my schedule');
      const th = msg('bot', '<span class="muted">Reading your schedule…</span>');
      try {
        let content = text;
        if (file && isDocx(file)) {
          content = `Class schedule from a Word document. Table rows are written as "cell | cell | cell".\n\n${(await docxToText(file)).slice(0, 40000)}${text ? `\n\nExtra notes from the student: ${text}` : ''}`;
        } else if (file) {
          const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = () => rej(new Error('Could not read the file')); r.readAsDataURL(file); });
          const media = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : 'image/png');
          content = [{ type: media === 'application/pdf' ? 'document' : 'image', source: { type: 'base64', media_type: media, data } }, { type: 'text', text: text ? `Extra notes from the student: ${text}` : 'Extract the weekly class meetings.' }];
        }
        const x = await aiJSON(`You read a college student's weekly class schedule (pasted text, a screenshot, or a PDF). Return ONLY JSON: {"classes":[{"code":string,"name":string,"days":["mon"|"tue"|"wed"|"thu"|"fri"|"sat"|"sun"],"start":"HH:MM","end":"HH:MM","label":"lecture"|"lab"|"recitation"|"discussion"}]}. 24-hour times. One entry per meeting pattern, so a lecture and a lab for the same course are two entries. The student's courses in @me are: ${S.courses.map(c => `${c.code} (${c.name || ''})`).join(', ') || 'none yet'}. When a class matches one of those, use that exact code. Skip online or asynchronous sections with no meeting time.`, content, { maxTokens: 2500, schema: SCHEMA.schedule });
        list = (x.classes || []).map(m => ({ code: m.code, name: m.name, days: (m.days || []).filter(d => WK.includes(d)), s: parseHM(m.start), e: parseHM(m.end), label: ['lecture', 'lab', 'recitation', 'discussion'].includes(m.label) ? m.label : 'lecture' })).filter(m => m.days.length && m.s != null && m.e > m.s);
        setAI('live');
      } catch (e) { list = []; msg('bot', esc(`I couldn't read that: ${e.message}`)); setAI('fallback'); }
      finally { th.remove(); UI.busy = false; }
    }
    if (!list.length) { msg('bot', 'I didn\'t find any class times in that. Try a clearer screenshot, or add them by hand.'); const c3 = card(`<div class="btns" style="margin:0"><button class="btn ghost">Enter them by hand</button></div>`); c3.querySelector('.btn').onclick = () => { lock(c3); openClassTimes(); }; return; }
    await withUndo('Imported class schedule', async () => {
      const added = [], newOnes = [];
      for (const m of list) {
        let course = matchCourse(m.code, m.name);
        if (!course) { P.mergeCourse({ source: 'chat', course: { code: m.code, name: m.name || '' }, items: [] }); course = S.courses.find(c => normCode(c.code) === normCode(String(m.code).slice(0, 16))); if (course) { course.source = 'your schedule'; newOnes.push(course.code); } }
        if (!course) continue;
        if (S.routine.some(r => r.course === course.code && Math.abs(r.s - m.s) < 0.01 && r.days.join() === m.days.join())) continue;
        S.routine.push({ id: uid('r'), days: m.days, s: m.s, e: m.e, title: `${course.code} ${m.label}`, course: course.code });
        added.push(`${course.code} ${m.label} ${daysTxt(m.days)} ${fmt(m.s)}`);
      }
      const r = P.resolveConflicts(); renderAll();
      logTool('classes.times', 'your class schedule', added.length ? `${added.length} meeting time${added.length > 1 ? 's' : ''} added` : 'nothing new');
      msg('bot', esc(added.length ? `Added ${added.join(', ')}.${newOnes.length ? ` ${newOnes.join(', ')} ${newOnes.length > 1 ? 'weren\'t' : 'wasn\'t'} in @me yet, so I added ${newOnes.length > 1 ? 'them as new classes' : 'it as a new class'}.` : ''}${r.moved.length ? ` I moved ${r.moved.length} study session${r.moved.length > 1 ? 's' : ''} that overlapped class.` : ''}${UI.google && !S.extras.classCal ? ' Want these on Google Calendar too? Turn on "Classes in Google Calendar" in the sidebar.' : ''}` : 'Those class times were already in @me.'));
      const still = S.courses.filter(c => !S.routine.some(x => x.course === c.code)).map(c => c.code);
      if (still.length) msg('bot', esc(`Still missing times for ${still.join(', ')}. Use "＋ Add class times" under ${still.length > 1 ? 'those classes' : 'that class'} in the sidebar.`));
    });
    refreshNext();
  };
}

/* ---------- class times form ---------- */
function openClassTimes(code) {
  if (!S.courses.length) return;
  $('ctCourse').innerHTML = S.courses.map(c => `<option value="${esc(c.code)}">${esc(c.code)}${c.name ? ' ' + esc(c.name) : ''}</option>`).join('');
  if (code) $('ctCourse').value = code;
  document.querySelectorAll('#ctDays .chip').forEach(b => b.setAttribute('aria-pressed', 'false'));
  $('ctStart').value = ''; $('ctEnd').value = ''; $('ctType').value = 'lecture'; $('ctErr').hidden = true;
  $('ctModal').classList.add('on'); setTimeout(() => $('ctDays').querySelector('.chip').focus(), 50);
}
const closeClassTimes = () => $('ctModal').classList.remove('on');
$('ctDays').addEventListener('click', e => { const b = e.target.closest('.chip'); if (b) b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); });
$('ctCancel').onclick = closeClassTimes;
$('ctModal').addEventListener('click', e => { if (e.target === $('ctModal')) closeClassTimes(); });
$('ctSave').onclick = async () => {
  const days = [...document.querySelectorAll('#ctDays .chip[aria-pressed="true"]')].map(b => b.dataset.v);
  const s = parseHM($('ctStart').value), e = parseHM($('ctEnd').value), err = t => { $('ctErr').textContent = t; $('ctErr').hidden = false; };
  if (!days.length) return err('Pick at least one day.');
  if (s == null || e == null) return err('Add a start and end time.');
  if (e <= s) return err('The end time has to be after the start time.');
  const code = $('ctCourse').value, label = $('ctType').value;
  closeClassTimes(); toggle(true);
  await withUndo(`Added ${code} ${label}`, async () => {
    S.routine.push({ id: uid('r'), days, s, e, title: `${code} ${label}`, course: code });
    const r = P.resolveConflicts(); renderAll();
    msg('bot', esc(`Added ${code} ${label}, ${daysTxt(days)} ${fmt(s)} to ${fmt(e)}.${r.moved.length ? ` I moved ${r.moved.length} study session${r.moved.length > 1 ? 's' : ''} that overlapped.` : ''}${UI.google && !S.extras.classCal ? ' Want your classes on Google Calendar too? Turn on "Classes in Google Calendar" in the sidebar.' : ''}`));
  });
  refreshNext();
};
function renderAssign() {
  const T = today();
  const list = liveItems().filter(i => i.date >= T).sort((a, b) => (a.date + (a.time ?? 23.99)).localeCompare(b.date + (b.time ?? 23.99)));
  if (!list.length) { $('alist').innerHTML = '<li class="muted">Nothing yet. Import a syllabus or connect Canvas.</li>'; return; }
  $('alist').innerHTML = (UI.allDue ? list : list.slice(0, 8)).map(i => `<li class="${i.type === 'exam' ? 'exam' : ''}${i.isNew ? ' new-a' : ''}"><div class="c">${esc(i.course)}<span class="tag">${i.surprise ? 'Surprise' : i.source === 'canvas' ? 'Canvas' : i.source === 'chat' ? 'Added' : 'Syllabus'}</span>${i.estimated ? '<span class="tag est" title="Moved from an older syllabus. Check the real date with your professor.">Estimated</span>' : ''}${i.weight ? ` <span class="muted" style="font-size:11px">${i.weight}%</span>` : ''}</div>${esc(i.name)}<div class="d">${dLabel(i.date)}${i.time != null ? ', ' + fmt(i.time) : ''}${P.isFinal(i) && i.time == null ? ` · <button class="link settime" data-final="${i.id}">Set time</button>` : ''}${!P.needsPrep(i) ? ' · no prep' : ''}</div>${i.type !== 'assignment' ? `<button class="xs pr-btn" data-practice="${i.id}" title="Practice for this ${i.type}" aria-label="Practice for ${esc(i.name)}">✏️</button>` : ''}${i.type !== 'assignment' && P.needsPrep(i) ? `<button class="xs mt-btn" data-mat-item="${i.id}" title="Add slides or notes for this ${i.type}" aria-label="Add slides or notes for ${esc(i.name)}">📎</button>` : ''}${P.levelOf(i.course) === 'none' ? '' : `<button class="xs np" data-np="${i.id}" data-prep="${i.noPrep ? 1 : 0}" title="${i.noPrep ? 'Plan study time for this again' : 'No prep needed for this'}" aria-label="${i.noPrep ? `Plan study time for ${esc(i.name)}` : `No prep needed for ${esc(i.name)}`}">${i.noPrep ? '↺' : '⊘'}</button>`}</li>`).join('')
    + (list.length > 8 ? `<li class="muted more"><button class="link moredue">${UI.allDue ? 'Show less' : `Show ${list.length - 8} more this semester`}</button></li>` : '');
}
function renderTopics() {
  const x = nextExam();
  if (!x) { $('readyH').textContent = 'Readiness'; $('topics').innerHTML = '<p class="muted" style="margin:0">Shows up once you have an exam coming.</p>'; return; }
  $('readyH').textContent = `${x.course} ${x.name.split(':')[0]} readiness`;
  const ts = x.topics?.length ? x.topics : ['Overall'];
  const skipped = ts.filter(t => P.isSkipped(x.course, t));
  $('topics').innerHTML = ts.map(t => {
    const v = S.ready[x.id + '|' + t], q = S.quiz[x.id + '|' + t], off = P.isSkipped(x.course, t);
    const btn = t === 'Overall' ? '' : `<button class="xs tg" data-topic="${esc(t)}" data-course="${esc(x.course)}" data-imp="${off ? 1 : 0}" title="${off ? 'Mark important again' : 'Not important: no prep needed'}" aria-label="${off ? `Mark ${esc(t)} important again` : `Mark ${esc(t)} not important`}">${off ? '↺' : '×'}</button>`;
    return `<div class="topic${off ? ' off' : ''}"><span>${esc(t)}</span>${off ? '<small>not important</small>' : (q ? `<small>quiz ${q}</small>` : '')}${off ? '' : `<span class="meter${v && v <= 2 ? ' low' : ''}" aria-label="${v ? v + ' of 5' : 'not rated'}">${[1, 2, 3, 4, 5].map(i => `<i class="${v && i <= v ? 'f' : ''}"></i>`).join('')}</span>`}${btn}</div>`;
  }).join('') + (skipped.length ? `<p class="hint">${skipped.length} topic${skipped.length > 1 ? 's' : ''} marked not important, so no prep for ${skipped.length > 1 ? 'them' : 'it'}.</p>` : '') + `<p class="hint">${relDay(x.date) === 'today' ? 'Today' : dLabel(x.date)}${x.weight ? `, ${x.weight}% of your grade` : ''}. Updates from quizzes, practice, and check-ins.</p><button class="link" data-practice="${x.id}">✏️ Practice for this ${x.type}</button>`;
}
function renderReviews() {
  const e = Object.entries(S.srs);
  $('reviews').innerHTML = e.length ? e.map(([k, r]) => `<div class="rq"><span>${esc(r.topic)}</span><span>${esc(r.label)}${r.onCal ? ', on calendar' : ''}<br>every ${r.interval} day${r.interval > 1 ? 's' : ''}</span></div>`).join('')
    : '<p class="muted" style="margin:0">Topics come back here on a spaced schedule after check-ins.</p>';
}
function renderStats() {
  const live = S.plan.filter(active), T = today();
  const planned = live.reduce((a, b) => a + mins(b), 0), done = live.filter(b => b.status === 'done').length;
  $('sPlan').textContent = hrs(planned); $('sStud').textContent = hrs(S.studied); $('sSes').textContent = `${done} of ${live.length}`;
  if (S.prefs) {
    const wk = live.filter(b => mondayOf(b.date) === mondayOf(T)).reduce((a, b) => a + mins(b), 0);
    $('sGoal').textContent = `${hrs(wk)} planned of ${S.prefs.goal}h`; $('sTrack').style.width = Math.min(100, wk / (S.prefs.goal * 60) * 100) + '%';
  }
}
function renderSettings() { $('setGrades').checked = S.extras.grades; $('setFocus').checked = S.extras.focus; $('setBed').value = String(S.extras.bedtime); $('setBrief').value = String(S.extras.brief); $('setClassCal').checked = !!S.extras.classCal; $('setDueCal').checked = !!S.extras.dueCal; $('setWeekend').value = S.extras.weekends || 'none'; $('setRhythm').value = S.extras.rhythm || 'steady'; $('setTermEnd').value = S.term?.end || ''; }
function remember(t) { if (S.memory.some(m => m.t === t)) return; S.memory.forEach(m => m.isNew = false); S.memory.push({ t, isNew: true }); renderMem(); }
function renderMem() { $('mem').innerHTML = S.memory.length ? S.memory.slice(-12).map(m => `<li class="${m.isNew ? 'new' : ''}">${esc(m.t)}</li>`).join('') : '<li class="muted" style="border:0;padding:0">Nothing yet. I learn as we go.</li>'; }
function renderBadge() {
  const n = S.alerts.length;
  $('launch').classList.toggle('alert', n > 0);
  $('launch').setAttribute('aria-label', n ? `Open @me, ${n} change${n > 1 ? 's' : ''} to review` : ($('chat').classList.contains('open') ? 'Close @me' : 'Open @me'));
}
function renderAll() { renderProficiency(); buildCal(); renderCourses(); renderAssign(); renderTopics(); renderReviews(); renderStats(); renderSettings(); renderMem(); renderBadge(); persist(); queueSync(); }

/* ---------- why this time ---------- */
function gcalLink(b) {
  const d = b.date.replace(/-/g, ''), t = h => h >= 24 ? '235900' : pad(Math.floor(h)) + pad(Math.round((h - Math.floor(h)) * 60)) + '00';
  const it = itemById(b.itemId);
  const details = `${b.focus || ''}${it ? `\nFor: ${it.course} ${it.name} (${dLabel(it.date)})` : ''}\nPlanned by @me`;
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent('📚 ' + b.title)}&dates=${d}T${t(b.s)}/${d}T${t(b.e)}&details=${encodeURIComponent(details)}&ctz=${encodeURIComponent(TZ)}`;
}
function reasons(b) {
  const r = [], it = itemById(b.itemId);
  if (b.why0) r.push(b.why0);
  if (b.kind === 'review') r.push(`Spaced review. ${b.topics[0]} was at ${b.score}/5, so it comes back to lock it in`);
  if (b.kind === 'extra') r.push(it?.surprise ? 'Added fast because this quiz was a surprise' : `Added because ${b.topics[0]} was at ${b.score}/5 after your check-in`);
  if (b.kind === 'group') r.push('A group review works best a couple of days out, once you\'ve studied solo');
  if (it) { const d = dayDiff(b.date, it.date); r.push(d <= 0 ? `It's the day ${it.name} is due` : `${d} day${d > 1 ? 's' : ''} before ${it.course} ${it.name}`); }
  if (it && it.weight && S.extras.grades) r.push(`${it.name} is ${it.weight}% of your ${it.course} grade, so it got ${S.plan.filter(x => x.itemId === it.id && active(x)).length} sessions`);
  const kind = P.stypeOf(b);
  if (b.short) r.push('Your week was tight, so this is a shorter session than usual');
  if (b.milestone && it) r.push(it.assigned ? `${it.name} is assigned ${dLabel(it.assigned)}, so the work is spread over milestones instead of a last-minute push` : `Big assignments get spread over milestones, starting about two weeks out`);
  if (kind === 'coding') r.push('Coding practice, since writing code is how CS exams test you');
  if (!isWeekday(b.date)) r.push('You allowed weekend studying');
  if (S.extras.rhythm === 'late' && !b.milestone && it && it.type !== 'assignment') r.push('You chose "closer to deadlines," so prep is bunched near the date');
  if (S.prefs) r.push(tod(b.s) === S.prefs.time ? `It's in the ${tod(b.s).toLowerCase()}, when you said you focus best` : `Your ${S.prefs.time.toLowerCase()} was booked that day, so this was the best opening`);
  const g = gaps(b.date, b.id).find(([a, z]) => a <= b.s + 1e-6 && z >= b.e - 1e-6);
  if (g) r.push(`You're free from ${fmt(g[0])} to ${fmt(g[1])} that day${UI.google ? ', based on your Google Calendar' : ''}`);
  const c = cutoff(b.date);
  r.push(`Ends by ${fmt(b.e)}, before your ${fmt(c)} sleep cutoff${c < S.extras.bedtime ? ' (an hour early since you have an exam the next day)' : ''}`);
  return r;
}
function showWhy(b, el) {
  document.querySelector('.pop')?.remove();
  const c = $('center').getBoundingClientRect(), r = el.getBoundingClientRect();
  const pop = document.createElement('div'); pop.className = 'pop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Why this time');
  const synced = S.gcal.map[b.id];
  pop.innerHTML = `<button class="x" aria-label="Close">×</button><h4>Why this time?</h4><p class="muted">${esc(b.title)}, ${when(b)}</p>
    <ul>${reasons(b).map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    ${b.status === 'planned' ? (synced ? `<p class="muted" style="margin:12px 0 0">✓ On your "@me Study" Google Calendar</p>` : `<p style="margin:12px 0 0"><a class="gc" href="${gcalLink(b)}" target="_blank" rel="noopener">＋ Add to Google Calendar</a></p>`) : ''}`;
  $('center').appendChild(pop);
  let left = r.right - c.left + 8; if (left + 300 > c.width) left = Math.max(8, r.left - c.left - 298);
  pop.style.left = left + 'px'; let top = r.top - c.top; const over = r.top + pop.offsetHeight - (innerHeight - 12); if (over > 0) top -= over; pop.style.top = Math.max(8, top) + 'px';
  pop.querySelector('.x').onclick = () => { pop.remove(); el.focus(); }; pop.querySelector('.x').focus();
}
document.addEventListener('click', e => { const p = document.querySelector('.pop'); if (p && !p.contains(e.target) && !e.target.closest('.ev.study') && !e.target.closest('.evx')) p.remove(); });

/* ---------- chat primitives ---------- */
const scroll = () => { $('stream').scrollTop = 1e6; if (!$('chat').classList.contains('open')) $('launch').classList.add('unread'); };
let started = false;
function toggle(open) {
  $('chat').classList.toggle('open', open); $('launch').setAttribute('aria-expanded', open);
  if (open) { $('launch').classList.remove('unread'); $('nudge')?.remove(); if (!started) { started = true; welcome(); } if (S.alerts.length && !UI.reviewShown) reviewCard(); setTimeout(() => $('input').focus(), 220); }
  renderBadge();
}
function msg(role, html) { const el = document.createElement('div'); el.className = 'msg ' + role; el.innerHTML = html; $('stream').appendChild(el); scroll(); return el; }
function card(html) { const el = document.createElement('div'); el.className = 'card'; el.innerHTML = html; $('stream').appendChild(el); scroll(); return el; }
function logTool(name, detail, result, bad) {
  const el = document.createElement('div'); el.className = 'tool'; el.textContent = `${name}  ${detail}`;
  el.insertAdjacentHTML('beforeend', `<br><span class="ok"${bad ? ' style="color:var(--exam)"' : ''}>${bad ? '✕' : '✓'} ${esc(result)}</span>`);
  $('stream').appendChild(el); scroll();
}
async function tool(name, detail, result, ms = 250) { await sleep(ms); logTool(name, detail, result); }
function chipGroup(c, onChange) {
  const pick = {};
  c.querySelectorAll('.chips').forEach(g => g.addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b || b.disabled) return;
    g.querySelectorAll('.chip').forEach(x => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true'); pick[g.dataset.k] = b.dataset.v; onChange(pick);
  }));
  return pick;
}
const chips = (k, opts) => `<div class="chips" data-k="${k}">${opts.map(o => `<button class="chip" aria-pressed="false" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div>`;
const lock = c => c.querySelectorAll('button,input,select').forEach(x => x.disabled = true);
async function needKey() {
  if (await hasKey()) return false;
  msg('bot', 'I need a Gemini key for that. It\'s free: add one in Settings and I\'ll be ready.');
  const c = card(`<div class="btns" style="margin:0"><button class="btn">Open Settings</button></div>`);
  c.querySelector('.btn').onclick = () => chrome.runtime.openOptionsPage();
  return true;
}

/* ---------- welcome + adding classes ---------- */
function welcome() {
  if (S.courses.length) {
    msg('bot', `Welcome back! 👋 ${S.plan.some(b => b.status === 'planned') ? 'Here\'s what\'s next.' : 'Ready when you are.'}`);
    if (!S.prefs) afterClasses(); else if (S.plan.some(b => b.status === 'planned')) nextCard(true); else offerCard();
    return;
  }
  msg('bot', 'Hey there, I\'m @me 👋 I don\'t know anything about your semester yet, so let\'s fix that. Type /help anytime to see everything I can do.');
  if (!UI.aiOk) msg('bot', 'Quick setup note: add an AI key in Settings (top right), a free Gemini key, so I can read syllabi and chat. Connecting Google Calendar lets me plan around your real schedule.');
  addClassCard(true);
}
function addClassCard(first) {
  const c = card(`<h3>${first ? 'Add your first class' : 'Add another class'}</h3>
    <p class="muted" style="margin:0">A syllabus works best, since it has every exam date and topic. Canvas fills in assignments.</p>
    <div class="btns"><button class="btn" data-a="syl">Import a syllabus</button>
    <button class="btn ghost" data-a="canvas">Import from Canvas</button>
    ${first ? '' : '<button class="btn ghost" data-a="done">That\'s all for now</button>'}</div>`);
  c.addEventListener('click', e => {
    const a = e.target.closest('button')?.dataset.a; if (!a || e.target.disabled || UI.busy) return; lock(c);
    if (a === 'syl') sylCard(); if (a === 'canvas') canvasImport();
    if (a === 'done') { msg('user', 'That\'s all for now'); afterClasses(); }
  });
}
async function announce(r, quiet) {
  const c = S.courses.find(x => x.code === r.code), its = S.items.filter(i => i.course === r.code && i.date >= today()).sort((a, b) => a.date.localeCompare(b.date));
  const ex = its.find(i => i.type === 'exam');
  renderAll();
  let m = `Got ${r.code}${c?.name ? ' (' + c.name + ')' : ''}! I found ${r.meet ? `${r.meet} weekly class time${r.meet !== 1 ? 's' : ''} and ` : ''}${r.added} dated item${r.added !== 1 ? 's' : ''}.`;
  if (ex) m += ` First exam: ${ex.name} on ${dLabel(ex.date)}${ex.weight ? `, worth ${ex.weight}% of your grade` : ''}.`;
  msg('bot', esc(m)); remember(`Taking ${r.code}`);
  if (quiet) return;
  if (S.prefs) offerReplan(r.code); else addClassCard(false);
}
function offerReplan(code) {
  const c = card(`<h3>Fit ${esc(code)} into your plan?</h3><div class="btns"><button class="btn" data-a="y">Yes, update my plan</button><button class="btn ghost" data-a="n">Not now</button></div>`);
  c.addEventListener('click', async e => {
    const a = e.target.closest('button')?.dataset.a; if (!a || e.target.disabled || UI.busy) return; lock(c);
    if (a === 'n') { msg('user', 'Not now'); msg('bot', 'No problem. Say "update my plan" whenever.'); return; }
    msg('user', 'Yes, update my plan'); UI.busy = true; try { await withUndo('Updated plan', () => replan()); } finally { UI.busy = false; }
  });
}
async function canvasImport() {
  msg('user', 'Import from Canvas');
  const st = await loadSettings();
  if (!st.canvasDomain || !st.canvasToken || !(await canvas.hasPermission(st.canvasDomain))) {
    msg('bot', 'Let\'s hook up Canvas first. In Settings, add your school\'s Canvas address and an access token, then click "Connect Canvas". Come back here and try again.');
    const c = card(`<div class="btns" style="margin:0"><button class="btn" data-a="o">Open Settings</button><button class="btn ghost" data-a="b">Back</button></div>`);
    c.addEventListener('click', e => { const a = e.target.closest('button')?.dataset.a; if (!a) return; lock(c); if (a === 'o') chrome.runtime.openOptionsPage(); addClassCard(!S.courses.length); });
    return;
  }
  UI.busy = true;
  const th = msg('bot', '<span class="muted">Looking up your Canvas courses…</span>');
  let rows;
  try { rows = await canvas.listCourses(); }
  catch (e) { th.remove(); UI.busy = false; msg('bot', esc(`Canvas didn't respond: ${e.message}`)); addClassCard(!S.courses.length); return; }
  th.remove(); UI.busy = false;
  logTool('canvas.get_courses', 'GET /api/v1/courses?include[]=term', `${rows.length} course${rows.length !== 1 ? 's' : ''}, ${rows.filter(r => r.current).length} this semester`);
  if (!rows.length) { msg('bot', 'Canvas didn\'t return any active courses. Try a syllabus instead.'); addClassCard(!S.courses.length); return; }
  const span = r => r.start || r.end ? `${r.start ? dShort(r.start) : '?'} to ${r.end ? dShort(r.end) : '?'}` : 'no dates';
  msg('bot', 'I checked these against your term dates. This semester\'s classes are already checked, so uncheck anything that isn\'t a real class.');
  const c = card(`<h3>Which classes are you taking?</h3>
    <div class="picks">${rows.map((r, i) => `<label class="pick"><input type="checkbox" data-i="${i}" ${r.current ? 'checked' : ''}><span><b>${esc(r.code)}</b> ${esc(r.name)}<small>${esc(r.term || 'No term')}, ${span(r)}${r.current ? '' : r.dated ? ', not this semester' : ''}</small></span></label>`).join('')}</div>
    <div class="btns"><button class="btn go">Import checked classes</button><button class="btn ghost back">Cancel</button></div>`);
  c.querySelector('.back').onclick = () => { lock(c); addClassCard(!S.courses.length); };
  c.querySelector('.go').onclick = async () => {
    const chosen = [...c.querySelectorAll('input:checked')].map(x => rows[+x.dataset.i]);
    if (!chosen.length) return;
    lock(c); msg('user', esc(`Import ${chosen.map(r => r.code).join(', ')}`)); UI.busy = true;
    const th2 = msg('bot', '<span class="muted">Reading assignments, exams, and syllabus pages…</span>');
    try {
      const results = await canvas.importCourses(chosen);
      th2.remove();
      logTool('canvas.get_assignments', 'assignments, quizzes, and exam events this term', `${results.reduce((a, r) => a + r.items.length, 0)} upcoming items`);
      const withSyl = results.filter(r => r.syllabusText && r.syllabusText.length > 80);
      if (withSyl.length && UI.aiOk) {
        for (const r of withSyl) {
          try {
            const x = await aiJSON(SYL_PROMPT(), `Course: ${r.course.code} ${r.course.name}\n\nSyllabus page from Canvas:\n${r.syllabusText}`, { schema: SCHEMA.syllabus, maxTokens: 3000 });
            r.meetings = [...(r.meetings || []), ...await pickSections(r.course.code, x.meetings || [])];
            r.schedule = { lectures: (x.lectures || []).filter(l => isISO(l.date) && l.date >= addDays(today(), -120)), no_class: x.no_class || [] };
            r.extra = (x.items || []).filter(it => it.type === 'exam' && /^\d{4}-\d{2}-\d{2}$/.test(it.date || ''));
            if (x.term?.end && !r.term.end) r.term.end = x.term.end;
            logTool('syllabus.read', `${r.course.code} Canvas syllabus page`, `${r.meetings.length} class time${r.meetings.length !== 1 ? 's' : ''}, ${r.extra.length} exam${r.extra.length !== 1 ? 's' : ''}`);
          } catch (e) { logTool('syllabus.read', `${r.course.code} Canvas syllabus page`, `skipped: ${e.message}`, true); }
        }
      }
      await withUndo('Canvas import', async () => {
        for (const r of results) {
          r.items.forEach(i => { if (!S.canvasSeen.includes(i.canvasId)) S.canvasSeen.push(i.canvasId); });
          // Exams that only appear in the syllabus page get added; ones Canvas already has get topics and weight filled in.
          for (const ex of r.extra || []) {
            const twin = r.items.find(i => i.type !== 'assignment' && Math.abs(new Date(i.date) - new Date(ex.date)) <= 864e5);
            if (twin) { if (!twin.topics?.length) twin.topics = ex.topics || []; if (twin.weight == null && ex.weight) twin.weight = ex.weight; }
            else r.items.push({ ...ex, canvasId: null });
          }
          if (r.term?.end && (!S.term?.end || r.term.end > S.term.end)) S.term = { name: r.term.name, start: r.term.start, end: r.term.end };
          const m = P.mergeCourse(r);
          if (r.schedule) { attachSchedule(m.code, r.schedule); fillExamTopics(m.code); }
          await announce(m, true);
        }
      });
      const found = results.filter(r => S.routine.some(x => x.course === r.course.code)).map(r => r.course.code);
      if (found.length) logTool('classes.times', 'Canvas calendar and syllabus pages', `found times for ${found.join(', ')}`);
      askForMissingTimes();
      msg('bot', 'I\'ll check Canvas every 30 minutes and flag anything new with a red ❗');
      if (S.prefs) offerReplan('your Canvas classes'); else addClassCard(false);
    } catch (e) {
      th2.remove(); msg('bot', esc(`Canvas import didn't work: ${e.message}`)); addClassCard(!S.courses.length);
    } finally { UI.busy = false; }
  };
}
function sylCard(prefill = '') {
  msg('bot', 'Drop in a syllabus as a PDF or Word file, or just paste the text, and I\'ll pull out class times, grading weights, lecture topics, and every exam and due date 📄');
  const c = card(`<h3>Import a syllabus</h3><p class="muted" style="margin:0 0 10px">Upload a PDF or Word (.docx) file, or paste the syllabus text below.</p>
    <input type="file" class="field" accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" aria-label="Syllabus file">
    <p class="muted small" style="margin:10px 0 4px">Or paste it here:</p>
    <textarea class="field" rows="6" aria-label="Paste your syllabus" placeholder="Copy everything from your syllabus (Ctrl+A, Ctrl+C) and paste it here"></textarea>
    ${S.courses.length ? `<label class="q" for="sylFor">This syllabus is for</label><select class="field" id="sylFor"><option value="">Figure it out from the syllabus</option>${S.courses.map(c => `<option value="${esc(c.code)}">${esc(c.code)}${c.name ? ' ' + esc(c.name) : ''}</option>`).join('')}</select>` : ''}
    <div class="btns"><button class="btn read" disabled>Read my syllabus</button></div>`);
  const inp = c.querySelector('input[type=file]'), ta = c.querySelector('textarea'), go = c.querySelector('.read');
  const ready = () => { go.disabled = !inp.files.length && ta.value.trim().length < 40; };
  inp.onchange = ready; ta.oninput = ready; if (prefill) { ta.value = prefill; ready(); }
  go.onclick = async () => {
    const file = inp.files[0], pasted = ta.value.trim();
    if ((!file && pasted.length < 40) || UI.busy) return;
    const forCode = c.querySelector('#sylFor')?.value || '';
    const isPdf = file && /\.pdf$/i.test(file.name);
    if (isPdf && !UI.aiOk) {   // PDFs need AI; pasted text and Word files don't
      msg('bot', 'Reading a PDF needs an AI key. Without one, open the PDF, select all the text (Ctrl+A), copy it, and paste it into the box above. I can read pasted text on my own.');
      return;
    }
    lock(c); msg('user', esc(file ? `Read ${file.name}` : `Here's my syllabus (${pasted.split('\n').length} lines)`)); UI.busy = true;
    const th = msg('bot', '<span class="muted">Reading your syllabus. Long ones can take a few seconds…</span>');
    let out = null, err = '', plainText = null;
    try {
      let content;
      if (isPdf) {
        const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = () => rej(new Error('Could not read the file')); r.readAsDataURL(file); });
        content = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }, { type: 'text', text: 'Extract the syllabus data.' }];
      } else if (file && isDocx(file)) {
        // Word files get converted to text here, since the AI can't open .docx directly.
        plainText = await docxToText(file);
        logTool('docx.read', file.name, `${plainText.split('\n').length} lines of text, tables kept as rows`);
        content = `Syllabus from a Word document. Table rows are written as "cell | cell | cell".\n\n${plainText.slice(0, 80000)}`;
      } else if (file && /\.doc$/i.test(file.name)) {
        throw new Error('That\'s an older .doc file. Open it in Word and use Save As to make a .docx or PDF, then try again.');
      } else {
        plainText = file ? await file.text() : pasted;
        content = `Syllabus text pasted by the student:\n\n${plainText.slice(0, 80000)}`;
      }
      if (UI.aiOk) {
        try {
          out = await aiJSON(SYL_PROMPT(), content, { maxTokens: 6000, schema: SCHEMA.syllabus });
          if (!out || (!out.items?.length && !out.meetings?.length && !out.lectures?.length)) { out = null; err = 'I didn\'t find any dates or class times in it.'; }
        } catch (e) { out = null; err = e.message; }
      }
      // No AI, or the AI failed: read the text with the built-in reader instead.
      if (!out && plainText) {
        const rough = readSyllabusText(plainText);
        if (rough.items.length || rough.meetings.length || rough.lectures.length) {
          out = rough;
          logTool('syllabus.read', 'built-in reader (no AI)', `${rough.meetings.length} class times, ${rough.lectures.length} lectures, ${rough.items.length} dated items`);
        } else if (!err) err = 'I couldn\'t find any dates or class times in that text.';
      }
    } catch (e) { out = null; err = e.message; }
    th.remove(); setAI(out && !out.readWithoutAI ? 'live' : 'fallback'); UI.busy = false;
    if (!out) {
      msg('bot', esc(`Hmm, that didn't work. ${err}${isPdf ? ' If it\'s a scanned image, try a Word version, or copy the text and paste it instead.' : ''}`));
      addClassCard(!S.courses.length); return;
    }
    if (out.readWithoutAI) msg('bot', esc(`I read this ${UI.aiOk ? 'with my backup reader, since the AI didn\'t answer' : 'without AI'}. It catches the usual patterns, but double-check the dates in Upcoming.`));
    else await tool('syllabus.read', file ? file.name : 'pasted text', `found ${out.meetings?.length || 0} class times, ${out.lectures?.length || 0} lectures, and ${out.items?.length || 0} dated items`);
    await processSyllabus(out, forCode, 'syllabus');
  };
  if (prefill) setTimeout(() => go.focus(), 50);
}

// Exact response shapes for Gemini's structured output.
const S_STR = { type: 'STRING' }, S_NSTR = { type: 'STRING', nullable: true }, S_NUM = { type: 'NUMBER', nullable: true };
const SCHEMA = {
  syllabus: { type: 'OBJECT', required: ['course', 'meetings', 'items'], properties: {
    course: { type: 'OBJECT', properties: { code: S_STR, name: S_STR } },
    term: { type: 'OBJECT', nullable: true, properties: { name: S_NSTR, start: S_NSTR, end: S_NSTR } },
    meetings: { type: 'ARRAY', items: { type: 'OBJECT', required: ['days', 'start', 'end'], properties: {
      days: { type: 'ARRAY', items: { type: 'STRING', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] } },
      start: S_STR, end: S_STR, label: { type: 'STRING', enum: ['lecture', 'lab', 'recitation', 'discussion'] }, detail: S_NSTR, choose_one: { type: 'BOOLEAN' } } } },
    lectures: { type: 'ARRAY', items: { type: 'OBJECT', required: ['date', 'topic'], properties: { date: S_STR, topic: S_STR } } },
    no_class: { type: 'ARRAY', items: S_STR },
    items: { type: 'ARRAY', items: { type: 'OBJECT', required: ['name', 'type', 'date'], properties: {
      name: S_STR, type: { type: 'STRING', enum: ['exam', 'quiz', 'assignment'] }, date: S_STR, time: S_NSTR, dur: S_NUM, weight: S_NUM,
      topics: { type: 'ARRAY', items: S_STR }, assigned: S_NSTR } } } } },
  quiz: { type: 'OBJECT', required: ['questions'], properties: { questions: { type: 'ARRAY', items: { type: 'OBJECT', required: ['topic', 'q', 'options', 'answer', 'explain'], properties: {
    topic: S_STR, q: S_STR, code: S_NSTR, options: { type: 'ARRAY', items: S_STR }, answer: { type: 'INTEGER' }, explain: S_STR } } } } },
  practice: { type: 'OBJECT', required: ['questions'], properties: { questions: { type: 'ARRAY', items: { type: 'OBJECT', required: ['topic', 'type', 'q', 'explain'], properties: {
    topic: S_STR, type: { type: 'STRING', enum: ['mc', 'short'] }, q: S_STR, code: S_NSTR, options: { type: 'ARRAY', items: S_STR, nullable: true },
    answer: { type: 'INTEGER', nullable: true }, model: S_NSTR, explain: S_STR } } } } },
  schedule: { type: 'OBJECT', required: ['classes'], properties: { classes: { type: 'ARRAY', items: { type: 'OBJECT', required: ['code', 'days', 'start', 'end'], properties: {
    code: S_STR, name: S_NSTR, days: { type: 'ARRAY', items: { type: 'STRING', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] } }, start: S_STR, end: S_STR,
    label: { type: 'STRING', enum: ['lecture', 'lab', 'recitation', 'discussion'] } } } } } },
  grade: { type: 'OBJECT', required: ['verdict', 'feedback'], properties: { verdict: { type: 'STRING', enum: ['Got it', 'Partly', 'Missed it'] }, feedback: S_STR } }
};

const SYL_PROMPT = () => `You extract structured data from a college course syllabus. Today is ${today()}. Return ONLY JSON, no markdown:
{"course":{"code":string,"name":string},
 "term":{"name":string,"start":"YYYY-MM-DD" or null,"end":"YYYY-MM-DD" or null},
 "meetings":[{"days":["mon"|"tue"|"wed"|"thu"|"fri"|"sat"|"sun"],"start":"HH:MM","end":"HH:MM","label":"lecture"|"lab"|"recitation"|"discussion","detail":string,"choose_one":boolean}],
 "lectures":[{"date":"YYYY-MM-DD","topic":string}],
 "no_class":["YYYY-MM-DD"],
 "items":[{"name":string,"type":"exam"|"quiz"|"assignment","date":"YYYY-MM-DD","time":"HH:MM" or null,"dur":number or null,"weight":number or null,"topics":[string],"assigned":"YYYY-MM-DD" or null}]}
Rules:
- Work out the syllabus's OWN semester and year from its text (like "Fall 2025") and use that year for dates written without one, like "8/26". Never change the year to match today.
- term: that semester's name and first and last dates (first class through the final exam) if you can tell.
- 24-hour times. For exams held during class with no time given, use the class meeting time, except final exams: finals are usually scheduled separately, so leave a final's time null unless the syllabus states it, and put its length in hours in "dur" if stated.
- meetings: regular weekly class meetings only, never office hours. List each schedule a student attends as ONE meeting with all its days (Tue and Thu at 6:00 is one meeting with days ["tue","thu"]). If the syllabus lists alternative sections the student picks just one of, of any kind (like lecture sections 001 and 002 at different times, or three recitation times with different TAs), include each one with choose_one true and put the section number, room, and instructor or TA in detail.
- lectures: one entry per class date in the course schedule, with a short topic under 40 characters. Leave out rows that are exams or holidays.
- no_class: dates when class doesn't meet (holidays, "No lecture").
- items: every graded exam, quiz, lab, project, and assignment that has its own date. assigned is the date it's handed out, if you can tell (like the schedule row it first appears on). weight is that single item's percent of the final grade ("Five projects @ 9% each" means 9; "Thirteen labs @ 2% each" means 2). topics: what the item covers, if stated.
- Names under 45 characters. Max 60 items.`;

const isISO = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
// Asks a multiple-choice question in chat and waits for the answer.
function choose(title, sub, options) {
  return new Promise(resolve => {
    const c = card(`<h3>${esc(title)}</h3>${sub ? `<p class="muted" style="margin:0">${esc(sub)}</p>` : ''}
      <div class="btns">${options.map((o, i) => `<button class="btn${i ? ' ghost' : ''}" data-i="${i}">${esc(o.label)}</button>`).join('')}</div>`);
    c.addEventListener('click', e => { const b = e.target.closest('button'); if (!b || b.disabled) return; lock(c); const o = options[+b.dataset.i]; msg('user', esc(o.label)); resolve(o.value); });
  });
}
const seasonOf = d => { const m = fromIso(d).getMonth() + 1; return m <= 5 ? 'Spring' : m <= 7 ? 'Summer' : 'Fall'; };
// Moves every date by whole weeks (364 days per year), so a Tuesday class stays on Tuesday.
function shiftDates(out, days) {
  const mv = d => isISO(d) ? addDays(d, days) : d;
  out.items = (out.items || []).map(i => ({ ...i, date: mv(i.date), assigned: mv(i.assigned), estimated: true }));
  out.lectures = (out.lectures || []).map(l => ({ ...l, date: mv(l.date) }));
  out.no_class = (out.no_class || []).map(mv);
  if (out.term) out.term = { ...out.term, start: mv(out.term.start), end: mv(out.term.end) };
}
// Exams with no listed topics cover the lectures since the previous exam.
function fillExamTopics(code) {
  const c = S.courses.find(x => x.code === code); if (!c?.lectures?.length) return 0;
  const exams = S.items.filter(i => i.course === code && i.type === 'exam' && i.status !== 'cancelled').sort((x, y) => x.date.localeCompare(y.date));
  let prev = '0000-00-00', n = 0;
  for (const x of exams) {
    if (!x.topics?.length) {
      const tp = c.lectures.filter(l => l.date > prev && l.date < x.date).map(l => l.topic).filter(t => !/review session|no lecture|exam/i.test(t));
      if (tp.length) { x.topics = [...new Set(tp)].slice(0, 12); x.topicsFromLectures = true; n++; }
    }
    prev = x.date;
  }
  return n;
}
// Saves lecture topics and no-class days onto a course.
function attachSchedule(code, out) {
  const c = S.courses.find(x => x.code === code); if (!c) return;
  const lec = (out.lectures || []).filter(l => isISO(l.date) && l.topic).map(l => ({ date: l.date, topic: String(l.topic).slice(0, 40) }));
  if (lec.length) { const m = new Map((c.lectures || []).map(l => [l.date, l])); lec.forEach(l => m.set(l.date, l)); c.lectures = [...m.values()].sort((x, y) => x.date.localeCompare(y.date)); }
  const nc = (out.no_class || []).filter(isISO);
  if (nc.length) c.noClass = [...new Set([...(c.noClass || []), ...nc])].sort();
  if (out.term?.end && isISO(out.term.end) && out.term.end >= today() && (!S.term?.end || out.term.end > S.term.end)) S.term = { name: out.term.name || '', start: out.term.start || null, end: out.term.end };
}
// The full syllabus import: check the semester, ask about sections, then add everything.
// Finals are usually on the school's finals schedule, so ask for the time instead of guessing.
// Resolves once the student answers, so the next card doesn't push the question out of view.
function askFinalTime(it) {
  if (!it || it.time != null) return Promise.resolve();
  return new Promise(resolve => {
  toggle(true);
  const lec = S.routine.find(r => r.course === it.course && r.days.includes(wkey(it.date)) && !/lab|recitation|discussion/i.test(r.title));
  msg('bot', esc(`When is your ${it.course} ${it.name} on ${dLabel(it.date)}? Finals usually follow your school's finals schedule, so they're often at a different time than lecture.`));
  const c = card(`<h3>${esc(it.course)} ${esc(it.name)}: what time?</h3>
    <div class="row2"><div><label for="fnTime">Starts at</label><input class="field" type="time" id="fnTime"></div>
    <div><label>How long?</label>${chips('len', ['1.5 hours', '2 hours', '3 hours'])}</div></div>
    <div class="btns"><button class="btn save">Save</button>${lec ? `<button class="btn ghost" data-a="lec">It's at lecture time (${fmt(lec.s)})</button>` : ''}<button class="btn ghost" data-a="later">I don't know yet</button></div>`);
  const pick = chipGroup(c, () => {}); c.querySelector('[data-k="len"] [data-v="2 hours"]').setAttribute('aria-pressed', 'true'); pick.len = '2 hours';
  const done = async (time, dur, label) => {
    lock(c); msg('user', esc(label));
    if (time == null) { msg('bot', esc(`No problem. When you know it, tell me something like "my ${it.course} final is at 8am", or use Set time next to it in Upcoming.`)); resolve(); return; }
    await withUndo(`${it.name} time`, async () => {
      it.time = time; it.dur = dur; renderAll();
      msg('bot', esc(`Got it: ${it.course} ${it.name}, ${dLabel(it.date)}, ${fmt(time)} to ${fmt(Math.min(24, time + dur))}.`));
    });
    resolve();
  };
  c.querySelector('.save').onclick = () => { const t = parseHM(c.querySelector('#fnTime').value); if (t == null) { c.querySelector('#fnTime').focus(); return; } const d = { '1.5 hours': 1.5, '2 hours': 2, '3 hours': 3 }[pick.len] || 2; done(t, d, `${fmt(t)}, ${pick.len}`); };
  c.querySelector('[data-a="lec"]')?.addEventListener('click', () => done(lec.s, lec.e - lec.s, 'It\'s at lecture time'));
  c.querySelector('[data-a="later"]').onclick = () => done(null, null, 'I don\'t know yet');
  });
}

// Sorts out a syllabus's meeting times. The same time on different days is one schedule (Tue + Thu at 6 PM),
// so those merge quietly. Several different times for the same kind of meeting, or anything labeled as a
// section, means the student only attends one of them, so ask. Lectures come first, then recitations and labs.
async function pickSections(code, list) {
  const WKO = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const clean = list.map(m => ({ ...m, label: ['lecture', 'recitation', 'lab', 'discussion'].includes(m.label) ? m.label : 'lecture', days: (m.days || []).filter(d => WKO.includes(d)) }))
    .filter(m => m.days.length && parseHM(m.start) != null && parseHM(m.end) != null && parseHM(m.end) > parseHM(m.start));
  const merged = [];
  for (const m of clean) {
    const twin = merged.find(x => x.label === m.label && x.start === m.start && x.end === m.end && !x.choose_one && !m.choose_one && (x.detail || '') === (m.detail || '') && !x.days.some(d => m.days.includes(d)));
    if (twin) twin.days = [...twin.days, ...m.days].sort((p, q) => WKO.indexOf(p) - WKO.indexOf(q));
    else merged.push({ ...m, days: [...m.days] });
  }
  const isSection = m => /\b(section|sec\.?|§)\s*\w|\b0\d\d\b/i.test(m.detail || '');
  const out = [];
  for (const label of ['lecture', 'recitation', 'lab', 'discussion']) {
    const group = merged.filter(m => m.label === label); if (!group.length) continue;
    const flagged = group.filter(m => m.choose_one), plain = group.filter(m => !m.choose_one);
    let ask = null, canBeAll = false;
    if (flagged.length >= 2) { ask = flagged; out.push(...plain); }
    else if (plain.length >= 2 && (new Set(plain.map(m => `${m.start}-${m.end}`)).size > 1 || plain.filter(isSection).length >= 2)) { ask = plain; canBeAll = true; out.push(...flagged); }
    if (!ask) { out.push(...group); continue; }
    const sorted = [...ask].sort((p, q) => WKO.indexOf(p.days[0]) - WKO.indexOf(q.days[0]) || String(p.start).localeCompare(String(q.start)));
    const word = label === 'lecture' ? 'lecture section' : label;
    const desc = m => `${daysTxt(m.days)} ${fmt(parseHM(m.start))} to ${fmt(parseHM(m.end))}${m.detail ? `, ${String(m.detail).slice(0, 40)}` : ''}`;
    const v = await choose(`Which ${word} are you in?`, `${code} lists ${sorted.length} ${label} times. Pick yours so I plan around the right one.`,
      [...sorted.map((m, i) => ({ label: desc(m), value: i })), ...(canBeAll ? [{ label: 'I go to all of these', value: 'all' }] : []), { label: 'Not sure yet', value: -1 }]);
    if (v === 'all') out.push(...sorted);
    else if (v === -1) msg('bot', esc(`No worries. Add your ${word} later with "＋ Add class times" in the sidebar.`));
    else out.push(sorted[v]);
  }
  return out.map(({ choose_one, ...m }) => m);
}

async function processSyllabus(out, forCode, source) {
  const T = today();
  const dates = [...(out.items || []).map(i => i.date), ...(out.lectures || []).map(l => l.date), out.term?.end].filter(isISO).sort();
  const termName = out.term?.name || (dates[0] ? `${seasonOf(dates[0])} ${dates[0].slice(0, 4)}` : 'an earlier semester');
  if (dates.length && dates.at(-1) < addDays(T, -3)) {
    // Everything is in the past. Usually that's last year's syllabus for a class you're taking now.
    let k = 1; while (addDays(dates.at(-1), 364 * k) < T && k < 8) k++;
    const startsOk = addDays(dates[0], 364 * k) <= addDays(T, 45);
    const newName = `${seasonOf(addDays(dates[0], 364 * k))} ${addDays(dates[0], 364 * k).slice(0, 4)}`;
    msg('bot', esc(`Heads up: this syllabus is for ${termName}, so all of its dates have already passed.${startsOk ? ` If you're taking the class now, I can move it to ${newName}, keeping every class and deadline on the same day of the week.` : ''}`));
    const pick = await choose(startsOk ? `Move it to ${newName}?` : 'This is an old syllabus', startsOk ? 'The dates will be estimates until your professor posts this semester\'s syllabus. I\'ll mark them so you know.' : 'Its semester doesn\'t line up with this one, so I can only add it as-is.',
      startsOk ? [{ label: `Yes, move it to ${newName}`, value: 'shift' }, { label: 'Just add the class times', value: 'times' }, { label: 'Cancel', value: 'cancel' }]
               : [{ label: 'Just add the class times', value: 'times' }, { label: 'Cancel', value: 'cancel' }]);
    if (pick === 'cancel') { msg('bot', 'No problem, I left it out.'); return false; }
    if (pick === 'shift') { shiftDates(out, 364 * k); if (out.term) out.term.name = `${newName} (estimated from ${termName})`; logTool('syllabus.shift', `${termName} → ${newName}`, `moved ${out.items.length} deadlines and ${out.lectures.length} lectures, same weekdays`); }
    else { out.items = []; out.lectures = []; out.no_class = []; }
  }
  // Ask which section is theirs when the syllabus lists several lecture, recitation, lab, or discussion times.
  out.meetings = await pickSections(out.course?.code || 'This class', out.meetings || []);
  const target = forCode ? S.courses.find(x => x.code === forCode) : matchCourse(out.course?.code, out.course?.name);
  if (target) out.course = { code: target.code, name: target.name || out.course?.name };
  await withUndo(`Added ${out.course?.code || 'class'}`, async () => {
    const r = P.mergeCourse({ ...out, source });
    const code = r.code; attachSchedule(code, out);
    const filled = fillExamTopics(code);
    await announce(r, true);
    const c = S.courses.find(x => x.code === code), next = (c?.lectures || []).filter(l => l.date >= T);
    const bits = [];
    if (c?.lectures?.length) bits.push(`${c.lectures.length} lecture topics${next[0] ? `, next up ${dLabel(next[0].date)}: ${next[0].topic}` : ''}`);
    if (c?.noClass?.length) bits.push(`${c.noClass.length} day${c.noClass.length > 1 ? 's' : ''} with no class`);
    if (filled) bits.push(`exam topics filled in from the lectures before each exam`);
    if (bits.length) msg('bot', esc(`I also saved ${bits.join(', ')}.${S.items.some(i => i.course === code && i.estimated) ? ' Deadlines moved from the old syllabus are marked "Estimated" in Upcoming.' : ''}`));
    renderAll();
  });
  for (const f of liveItems().filter(i => i.course === (out.course?.code || '') && P.isFinal(i) && i.time == null && i.date >= today())) await askFinalTime(f);
  if (S.prefs) offerReplan(out.course?.code || 'this class'); else addClassCard(false);
  return true;
}

/* ---------- weekly routine parsing ---------- */
const DAYMAP = { monday: 'mon', mon: 'mon', tuesday: 'tue', tues: 'tue', tue: 'tue', wednesday: 'wed', wed: 'wed', thursday: 'thu', thurs: 'thu', thur: 'thu', thu: 'thu', friday: 'fri', fri: 'fri', saturday: 'sat', sat: 'sat', sunday: 'sun', sun: 'sun', weekdays: 'wk' };
function parseDays(str) {
  const out = new Set();
  for (let tok of str.toLowerCase().split(/[\s,\/&+]+|\band\b/).filter(Boolean)) {
    tok = tok.replace(/s$/, m => tok.length > 3 ? '' : m);
    if (DAYMAP[tok]) { if (DAYMAP[tok] === 'wk') ['mon', 'tue', 'wed', 'thu', 'fri'].forEach(d => out.add(d)); else out.add(DAYMAP[tok]); continue; }
    if (/^(m|t|w|th|r|f|tu)+$/.test(tok)) {
      let i = 0; while (i < tok.length) {
        if (tok.startsWith('th', i)) { out.add('thu'); i += 2; } else if (tok.startsWith('tu', i)) { out.add('tue'); i += 2; }
        else { out.add({ m: 'mon', t: 'tue', w: 'wed', r: 'thu', f: 'fri' }[tok[i]]); i++; }
      }
    }
  }
  return [...out].filter(Boolean);
}
function parseRoutine(text) {
  const res = [];
  const re = /([a-z0-9][a-z0-9' ]*?)\s+(?:meets\s+)?(?:on\s+)?((?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*|weekdays|[mtwrf]{1,5}|th|tth)(?:[\s,\/&+]+(?:and\s+)?(?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*|[mtwrf]{1,5}|th))*)\s+(?:from\s+)?(\d{1,2}(?::\d{2})?)\s*(am|pm)?\s*(?:-|–|to|until)\s*(\d{1,2}(?::\d{2})?)\s*(am|pm)?/gi;
  let m;
  while ((m = re.exec(text))) {
    const days = parseDays(m[2]); if (!days.length) continue;
    const hm = t => { const [h, mi] = t.split(':'); return (+h) + (mi ? +mi / 60 : 0); };
    let s = hm(m[3]), e = hm(m[5]); const ap1 = (m[4] || '').toLowerCase(), ap2 = (m[6] || '').toLowerCase();
    const to24 = (h, ap) => ap === 'pm' && h < 12 ? h + 12 : ap === 'am' && h >= 12 ? h - 12 : h;
    if (ap2) e = to24(e, ap2); else if (e < 8) e += 12;
    if (ap1) s = to24(s, ap1); else if (ap2 === 'pm' && s < 12 && s + 12 <= e) s += 12; else if (s < 8) s += 12;
    if (e <= s) continue;
    let title = m[1].trim().replace(/^(i |and |also |i have |my )+/i, '').replace(/^(have|got)\s+/i, '');
    title = title ? title[0].toUpperCase() + title.slice(1) : 'Busy';
    const course = S.courses.find(c => title.toLowerCase().startsWith(c.code.toLowerCase()))?.code;
    res.push({ title: (course ? `${course} ${/\blab\b/i.test(title) ? 'lab' : /recitation/i.test(title) ? 'recitation' : 'class'}` : title).slice(0, 24), days, s, e, course, raw: title });
  }
  return res;
}
async function addRoutine(text) {
  let list = null;
  try {
    const p = await aiJSON(`Turn the student's description of their weekly schedule into JSON. Return ONLY JSON: {"items":[{"title":string,"days":["mon"|"tue"|"wed"|"thu"|"fri"|"sat"|"sun"],"start":"HH:MM","end":"HH:MM","course":string or null}]}. 24-hour times. Title under 24 chars. If it's a class meeting for one of these courses, set course to its code: ${S.courses.map(c => c.code).join(', ') || 'none'}. Empty list if nothing usable.`, text);
    list = (p.items || []).map(x => ({ title: String(x.title || 'Busy').slice(0, 24), days: (x.days || []).filter(d => WK.includes(d)), s: parseHM(x.start), e: parseHM(x.end), course: S.courses.find(c => c.code === x.course)?.code })).filter(x => x.days.length && x.s != null && x.e > x.s);
  } catch (e) { list = null; }
  if (!list) list = parseRoutine(text);
  list.forEach(x => S.routine.push({ id: uid('r'), ...x, course: x.course || undefined }));
  return list;
}

/* ---------- setup ---------- */
function afterClasses() {
  if (!S.courses.length) { msg('bot', 'Add at least one class first, then we can plan.'); addClassCard(true); return; }
  setStep(1); setupCard();
}
function setupCard() {
  msg('bot', 'Nice! Now tell me a little about how you like to study.');
  const c = card(`<h3>Tell me about you</h3>
    <div class="q">How many hours a week do you want to study?</div>${chips('goal', ['6h', '8h', '10h', '12h'])}
    <div class="q">When does your brain work best?</div>${chips('time', ['Morning', 'Afternoon', 'Evening'])}
    <div class="q">How long can you focus in one go?</div>${chips('len', ['45 min', '60 min', '90 min'])}
    <div class="q">Do you study with a group?</div>${chips('group', ['Yes', 'Sometimes', 'Nope, solo'])}
    <div class="q">Anything else on your weekly schedule? Optional${UI.google ? '. I already see your Google Calendar' : ''}</div>
    <input class="field" placeholder="e.g. Work Tue and Thu 2-6pm, soccer MWF 4-5:30pm">
    <div class="btns"><button class="btn save" disabled>Next</button></div>`);
  const pick = chipGroup(c, p => { c.querySelector('.save').disabled = !(p.goal && p.time && p.len && p.group); });
  c.querySelector('.save').onclick = async () => {
    if (UI.busy) return; lock(c); UI.busy = true;
    try {
      const rt = c.querySelector('input').value.trim();
      S.prefs = { goal: parseInt(pick.goal), time: pick.time, len: parseInt(pick.len), group: pick.group !== 'Nope, solo' };
      msg('user', esc(`${pick.goal} a week, ${pick.time.toLowerCase()}s, ${pick.len} sessions, ${pick.group === 'Nope, solo' ? 'solo' : 'with a group'}${rt ? '. ' + rt : ''}`));
      remember(`Studies best in the ${pick.time.toLowerCase()}`); remember(`Prefers ${pick.len} sessions`);
      remember(S.prefs.group ? 'Likes some group studying' : 'Prefers studying solo');
      if (rt) {
        const list = await addRoutine(rt);
        logTool('routine.add', 'weekly schedule', list.length ? list.map(x => `${x.title} ${daysTxt(x.days)} ${fmt(x.s)}`).join(', ') : 'couldn\'t read that one', !list.length);
        if (!list.length) msg('bot', 'I couldn\'t quite read that schedule. You can tell me later, like "I work Tue and Thu 2-6pm".');
      }
      renderAll(); extrasCard();
    } finally { UI.busy = false; }
  };
}
function extrasCard() {
  msg('bot', 'Love it, noted! A few optional extras. You can change these anytime in the sidebar.');
  const c = card(`<h3>Optional extras</h3>
    <div class="q">Use grade weights to decide what gets the most time?</div>${chips('g', ['Yes', 'No'])}
    <div class="q">Block distracting sites like YouTube while you study?</div>${chips('f', ['Yes', 'No'])}
    <div class="q">When should you be done studying for the night?</div>${chips('b', ['10 PM', '11 PM', 'Midnight'])}
    <div class="q">Study on weekends too?</div>${chips('w', ['No', 'Saturdays', 'Sundays', 'Both'])}
    <div class="q">Spread prep out early, or keep it closer to deadlines?</div>${chips('r', ['Steady', 'Closer to deadlines'])}
    <div class="btns"><button class="btn save" disabled>Save extras</button><button class="btn ghost skip">Skip, use defaults</button></div>`);
  const pick = chipGroup(c, p => { c.querySelector('.save').disabled = !(p.g && p.f && p.b && p.w && p.r); });
  const finish = x => {
    lock(c); S.extras = { ...S.extras, grades: x.g === 'Yes', focus: x.f === 'Yes', bedtime: { '10 PM': 22, '11 PM': 23, 'Midnight': 24 }[x.b],
      weekends: { No: 'none', Saturdays: 'sat', Sundays: 'sun', Both: 'both' }[x.w] || 'none', rhythm: x.r === 'Closer to deadlines' ? 'late' : 'steady' };
    msg('user', esc(x.skipped ? 'Skip, use defaults' : `Grade weights: ${x.g}. Focus mode: ${x.f}. Done by ${x.b}.`));
    remember(`Done studying by ${fmt(S.extras.bedtime)}`); if (S.extras.grades) remember('Prioritizes by grade weight');
    chrome.runtime.sendMessage({ type: 'schedule-briefing' }).catch(() => {});
    renderAll(); setStep(2);
    if (S.courses.length >= 2) levelsCard(); else offerCard();
  };
  c.querySelector('.save').onclick = () => finish(pick);
  c.querySelector('.skip').onclick = () => finish({ g: 'Yes', f: 'Yes', b: '11 PM', w: 'No', r: 'Steady', skipped: true });
}
function levelsCard() {
  msg('bot', 'One more: not every class needs the same study time. Gen-eds and classes outside your major can go Light or None.');
  const c = card(`<h3>How much study time does each class need?</h3>
    ${S.courses.map((x, i) => `<div class="q">${esc(x.code)}${x.name ? ' ' + esc(x.name) : ''}</div>${chips('c' + i, ['Normal', 'Light', 'None'])}`).join('')}
    <div class="btns"><button class="btn save">Continue</button></div>`);
  const pick = chipGroup(c, () => {});
  S.courses.forEach((x, i) => c.querySelector(`[data-k="c${i}"] [data-v="${LEVELS[x.priority || 'normal']}"]`)?.setAttribute('aria-pressed', 'true'));
  c.querySelector('.save').onclick = () => {
    lock(c);
    const changed = [];
    S.courses.forEach((x, i) => { const v = (pick['c' + i] || LEVELS[x.priority || 'normal']).toLowerCase(); if (v !== (x.priority || 'normal')) { x.priority = v; changed.push(`${x.code}: ${LEVELS[v]}`); } });
    msg('user', esc(changed.length ? changed.join(', ') : 'All normal'));
    changed.forEach(t => remember(t.replace(': None', ' doesn\'t need study time').replace(': Light', ' only needs light study time').replace(': Normal', ' gets normal study time')));
    renderAll(); offerCard();
  };
}
function offerCard() {
  const T = today(), end = addDays(T, 21), soon = liveItems().filter(i => i.date >= T && i.date <= end).sort((a, b) => a.date.localeCompare(b.date));
  const big = [...soon].sort((a, b) => (b.weight || 0) - (a.weight || 0))[0];
  if (!soon.length) {
    const future = liveItems().filter(i => i.date >= T).sort((p, q) => p.date.localeCompare(q.date));
    // Only past dates: almost always an old syllabus. Explain and offer to move it.
    if (!future.length) { if (S.items.length) noFitHelp(21, true); else msg('bot', 'Nothing is due yet. Once your classes have deadlines, just say "plan my week".'); return; }
    msg('bot', esc(`Nothing is due in the next three weeks. Your next deadline is ${future[0].course} ${future[0].name} on ${dLabel(future[0].date)}, so I can plan ahead for it.`));
    const c0 = card(`<h3>Plan ahead for it?</h3><div class="btns"><button class="btn" data-a="yes">Yes, plan ahead</button><button class="btn ghost" data-a="no">Not right now</button></div>`);
    c0.addEventListener('click', async e => { const v = e.target.closest('button')?.dataset.a; if (!v || e.target.disabled || UI.busy) return; lock(c0);
      if (v === 'no') { msg('user', 'Not right now'); msg('bot', 'All good! Say "plan my week" whenever you\'re ready.'); return; }
      msg('user', 'Yes, plan ahead'); UI.busy = true; try { await withUndo('Your study plan', () => planAll()); } finally { UI.busy = false; } });
    return;
  }
  msg('bot', esc(`Okay, here's what's coming up 👀 You've got ${soon.length} thing${soon.length > 1 ? 's' : ''} due in the next three weeks${big ? `, and the biggest is ${big.course} ${big.name} on ${dLabel(big.date)}${big.weight ? ` (${big.weight}% of your grade)` : ''}` : ''}.`));
  if (!UI.google) msg('bot', 'Tip: connect Google Calendar (top bar) before planning, so I can work around your real events and add sessions automatically.');
  const c = card(`<h3>Want me to schedule study time for all of it?</h3><p class="muted" style="margin:0">I'll fit it around your classes on weekdays and keep your evenings sane.</p>
    <div class="btns"><button class="btn" data-a="yes">Yes, plan it</button>${UI.google ? '' : '<button class="btn ghost" data-a="g">Connect Google first</button>'}<button class="btn ghost" data-a="no">Not right now</button></div>`);
  c.addEventListener('click', async e => {
    const a = e.target.closest('button')?.dataset.a; if (!a || e.target.disabled || UI.busy) return;
    if (a === 'g') { await connectGoogle(); if (UI.google) c.querySelector('[data-a="g"]')?.remove(); return; }
    lock(c);
    if (a === 'no') { msg('user', 'Not right now'); msg('bot', 'All good! Just say "plan my week" whenever you\'re ready.'); return; }
    msg('user', 'Yes, plan it'); UI.busy = true; try { await withUndo('Your study plan', () => planAll()); } finally { UI.busy = false; }
  });
}

/* ---------- planning ---------- */
// Usually 3 weeks ahead. If nothing worth prepping is due by then, reach out to the next deadline (up to 10 weeks).
function planHorizon() {
  const T = today(), soon = liveItems().some(i => i.date >= T && i.date <= addDays(T, 21) && P.needsPrep(i));
  if (soon) return 21;
  const next = liveItems().filter(i => i.date > addDays(T, 21) && P.needsPrep(i)).sort((x, y) => x.date.localeCompare(y.date))[0];
  return next ? Math.min(70, dayDiff(T, next.date) + 1) : 21;
}
async function planAll() {
  await refreshBusy(true);
  await tool('sleep.protect', `cutoff ${fmt(S.extras.bedtime)}, an hour earlier before exams`, 'applied to every day');
  if (S.extras.grades) await tool('grades.prioritize', 'grade weights', 'bigger exams get more sessions');
  const hz = planHorizon();
  if (hz > 21) logTool('planner.horizon', 'nothing due in 3 weeks', `planning ahead ${Math.round(hz / 7)} weeks, to your next deadline`);
  const r = P.buildPlan(undefined, hz); r.horizon = hz;
  await tool('planner.schedule', `${Object.keys(r.per).length} deadlines`, `${r.created.length} sessions placed`, 300);
  UI.week = mondayOf(nextWeekday(today())); renderAll();
  await summarizePlan(r, false);
}
async function replan() {
  await refreshBusy(true);
  const removed = P.clearUpcoming();
  await tool('planner.clear_upcoming', '', `${removed} planned sessions cleared`);
  const hz = planHorizon();
  const r = P.buildPlan(undefined, hz); r.horizon = hz;
  await tool('planner.schedule', 're-plan with your latest info', `${r.created.length} sessions placed`, 300);
  renderAll(); await summarizePlan(r, true);
}
async function summarizePlan(r, isReplan) {
  const n = r.created.length;
  if (!n) { await noFitHelp(r.horizon || 21); return; }
  const exams = Object.values(r.per).filter(p => p.t.type === 'exam' && p.count > 0);
  let m = `${isReplan ? 'Updated!' : 'Done!'} I scheduled ${n} study session${n > 1 ? 's' : ''} over the next ${(r.horizon || 21) > 21 ? `${Math.round(r.horizon / 7)} weeks` : 'three weeks'}${S.extras.weekends && S.extras.weekends !== 'none' ? ', weekends included' : ', Monday to Friday'}.`;
  const proj = Object.values(r.per).filter(p => p.t.type === 'assignment' && P.isProject(p.t) && p.count > 1);
  if (proj.length) m += ` Projects start early: ${proj.map(p => `${shortName(p.t)} gets ${p.count} milestone sessions`).join(', ')}.`;
  if (exams.length) m += ` ${exams.map(p => `${p.t.course} ${shortName(p.t)} gets ${p.count}`).join(', ')}, spread out so nothing turns into a cram.`;
  m += ` Everything fits around your classes${UI.google ? ' and Google Calendar' : ''}, nothing runs past ${fmt(S.extras.bedtime)}, and nights before exams wrap up an hour early.`;
  const wk = S.plan.filter(b => active(b) && mondayOf(b.date) === mondayOf(today())).reduce((a, b) => a + mins(b), 0);
  if (S.prefs && wk > S.prefs.goal * 60 + 30) m += ` Heads up, this week is ${hrs(wk)}, a bit over your ${S.prefs.goal}h goal, because of what's due.`;
  const miss = Object.values(r.per).filter(p => p.missed);
  if (miss.length) m += ` I couldn't fit everything for ${miss.map(p => shortName(p.t)).join(' and ')}, so you might want to free up some time.`;
  if (r.skipped.length) m += ` ${r.skipped.map(shortName).join(', ')} ${r.skipped.length > 1 ? 'are' : 'is'} too soon to plan for.`;
  const shorts = r.created.filter(b => b.short).length;
  if (shorts) m += ` Your week is tight, so ${shorts} session${shorts > 1 ? 's are' : ' is'} shorter than usual.`;
  msg('bot', esc(m) + ' 💪');
  if (S.prefs.group && r.created.some(b => b.kind === 'group')) msg('bot', 'I also marked one session per exam as a group review. Text your group to lock in the time 👥');
  await gcalCard(r.created, isReplan);
  if (!isReplan) setTimeout(() => offerGoogleExtras(), 400);
  msg('bot', 'Tip: tap any study block to see why I picked that time. If you don\'t like a change, hit undo.');
  if (!isReplan && S.extras.brief) {
    msg('bot', `I'll also send you a quick briefing notification every weekday at ${fmt(S.extras.brief)} ☀️`);
    const bc = card(`<div class="btns" style="margin:0"><button class="btn ghost">Preview tomorrow's briefing</button></div>`);
    bc.querySelector('.btn').onclick = () => { lock(bc); showBriefing(nextWeekday(addDays(today(), 1))); };
  }
  setStep(3); nextCard();
}
// Moves every date for a class by whole weeks (364 days per year), so an old syllabus lands on this semester's weekdays.
function shiftCourse(code, years) {
  const mv = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? addDays(d, 364 * years) : d;
  S.items.forEach(i => { if (i.course === code) { i.date = mv(i.date); i.assigned = mv(i.assigned); i.estimated = true; } });
  const c = S.courses.find(x => x.code === code);
  if (c) { c.lectures = (c.lectures || []).map(l => ({ ...l, date: mv(l.date) })); c.noClass = (c.noClass || []).map(mv); }
}
async function noFitHelp(horizon, beforePlanning) {
  const d = P.diagnose(horizon), opts = [];
  let text = '';
  if (d.why === 'empty') { text = 'There\'s nothing to plan yet. Add a class with a syllabus or Canvas, and I\'ll plan around its deadlines.'; opts.push({ label: 'Add a class', value: 'add' }); }
  else if (d.why === 'past') {
    const years = Math.max(1, Math.round(dayDiff(d.newest.date, today()) / 365) || 1);
    text = `Every deadline I have is already in the past (the newest is ${d.newest.course} ${d.newest.name}, ${dLabel(d.newest.date)}). That usually means an old syllabus kept its old dates.`;
    d.courses.forEach(c => opts.push({ label: `Move ${c} to this semester`, value: 'shift:' + c + ':' + years }));
  }
  else if (d.why === 'later') { text = `Nothing is due soon. Your next deadline is ${d.next.course} ${d.next.name} on ${dLabel(d.next.date)}, and I couldn't find room before it either.`; }
  else if (d.why === 'noprep') {
    text = `Everything due soon is set to skip studying${d.courses.length ? `: ${d.courses.join(', ')} ${d.courses.length > 1 ? 'are' : 'is'} on "None" study time` : ''}${d.items.length ? `${d.courses.length ? ', and ' : ': '}${d.items.length} item${d.items.length > 1 ? 's are' : ' is'} marked "no prep"` : ''}.`;
    d.courses.forEach(c => opts.push({ label: `Give ${c} study time`, value: 'level:' + c }));
    if (d.items.length) opts.push({ label: 'Prep for the "no prep" items', value: 'prep' });
  }
  else if (d.why === 'full') {
    const desc = b => `"${b.title}"${b.kind === 'gcal' ? ' on your Google Calendar' : b.kind === 'class' ? ' (a class)' : ''}, ${b.days} day${b.days > 1 ? 's' : ''}`;
    text = `Your calendar is too full. In the next ${d.studyDays} study days, there's no open stretch long enough for even a 30-minute session before your ${fmt(S.extras.bedtime)} cutoff. The biggest blockers: ${d.blockers.map(desc).join('; ')}.`;
    d.blockers.filter(b => b.kind === 'gcal').forEach(b => opts.push({ label: `Ignore "${b.title}" for planning`, value: 'ignore:' + b.title }));
    if ((S.extras.weekends || 'none') === 'none') opts.push({ label: 'Allow weekends', value: 'weekends' });
    if (S.extras.bedtime < 24) opts.push({ label: 'Study until midnight', value: 'midnight' });
  }
  else { text = 'Everything worth prepping for is due too soon to fit a session before it. Try a later sleep cutoff, or allow weekends.'; if ((S.extras.weekends || 'none') === 'none') opts.push({ label: 'Allow weekends', value: 'weekends' }); if (S.extras.bedtime < 24) opts.push({ label: 'Study until midnight', value: 'midnight' }); }
  logTool('planner.diagnose', 'why nothing fit', d.why);
  msg('bot', esc(`${beforePlanning ? 'Before I plan, a heads-up.' : 'I couldn\'t fit any study sessions.'} ${text}`));
  if (!opts.length) return;
  const v = await choose('Want me to fix it?', 'I\'ll make the change and plan again.', [...opts, { label: 'Not now', value: 'no' }]);
  if (v === 'no') return;
  if (v === 'add') { addClassCard(!S.courses.length); return; }
  UI.busy = true;
  try {
    await withUndo('Fixed plan', async () => {
      if (v.startsWith('shift:')) { const [, c, y] = v.split(':'); shiftCourse(c, +y); logTool('syllabus.shift', c, `moved ${y} year${+y > 1 ? 's' : ''} ahead, same weekdays`); msg('bot', esc(`Moved ${c} to this semester. Those dates are marked "Estimated" until you get the real syllabus.`)); }
      if (v.startsWith('level:')) { const c = S.courses.find(x => x.code === v.slice(6)); if (c) c.priority = 'normal'; }
      if (v === 'prep') liveItems().forEach(i => { i.noPrep = false; });
      if (v.startsWith('ignore:')) { const t = v.slice(7); S.ignoredG = [...new Set([...(S.ignoredG || []), 'title:' + t])]; msg('bot', esc(`I'll plan as if "${t}" isn't there. It stays on your Google Calendar.`)); }
      if (v === 'weekends') S.extras.weekends = 'both';
      if (v === 'midnight') S.extras.bedtime = 24;
      renderAll(); await replan();
    });
  } finally { UI.busy = false; }
}

async function gcalCard(blocks, isReplan) {
  const list = blocks.filter(b => b.status === 'planned'); if (!list.length) return;
  if (UI.google) {
    clearTimeout(syncT); await runSync(true);
    const c = card(`<h3>✓ On your Google Calendar</h3><p class="muted" style="margin:0">${list.length} session${list.length > 1 ? 's are' : ' is'} on your "@me Study" calendar, with a reminder 10 minutes before each one. Changes and undos sync automatically.</p>
      <div class="btns"><a class="btn ghost" href="${gcal.calendarUrl()}" target="_blank" rel="noopener" style="text-decoration:none">Open Google Calendar</a></div>`);
    return;
  }
  const c = card(`<h3>Put it on your Google Calendar</h3>
    <p class="muted" style="margin:0">Connect Google Calendar and I'll add these automatically. Or add them one at a time:${isReplan ? ' (if you added old sessions before, delete those first)' : ''}</p>
    <ul class="slist">${list.map(b => `<li><span>${esc(b.title)}<small>${when(b)}</small></span><a class="gc" href="${gcalLink(b)}" target="_blank" rel="noopener" aria-label="Add ${esc(b.title)} to Google Calendar">＋ Add</a></li>`).join('')}</ul>
    <div class="btns"><button class="btn conn">Connect Google Calendar</button></div>`);
  c.querySelector('.conn').onclick = async () => { await connectGoogle(); if (UI.google) lock(c); };
}

/* ---------- session loop ---------- */
const isPast = b => { const T = today(); return b.date < T || (b.date === T && b.e <= nowH() - 0.05); };
const upcoming = () => S.plan.filter(b => b.status === 'planned' && !isPast(b)).sort((a, b) => a.date.localeCompare(b.date) || a.s - b.s);
// Sessions whose time passed without being started.
const missedSessions = () => S.plan.filter(b => b.status === 'planned' && isPast(b) && S.active?.id !== b.id).sort((a, b) => a.date.localeCompare(b.date) || a.s - b.s);
async function rescheduleMissed(b) {
  const m = P.relocate(b, today());
  if (!m) { b.status = 'skipped'; return false; }
  b.date = m.d; b.s = m.s.s; b.e = m.s.e; return true;
}
function missedCard() {
  const list = missedSessions(); if (!list.length || UI.missedOpen || UI.inSession) return;
  UI.missedOpen = true; toggle(true);
  msg('bot', esc(list.length === 1 ? `Your ${list[0].title} session (${when(list[0])}) already passed. Did you get to it?` : `${list.length} study sessions already passed. Did you get to them?`));
  const c = card(`<h3>Missed sessions</h3>
    <ul class="slist">${list.slice(0, 8).map(b => `<li data-id="${b.id}"><span>${esc(b.title)}<small>${when(b)}</small></span><span class="mbtns"><button class="btn ghost mini" data-a="did">Did it</button><button class="btn mini" data-a="move">Reschedule</button></span></li>`).join('')}</ul>
    <div class="btns"><button class="btn" data-a="moveall">Reschedule all</button><button class="btn ghost" data-a="didall">I did them all</button></div>`);
  const finish = () => { if (!c.querySelector('li:not(.gone)')) { lock(c); UI.missedOpen = false; refreshNext(); } };
  c.addEventListener('click', async e => {
    const bt = e.target.closest('button'); if (!bt || bt.disabled || UI.busy) return;
    const a = bt.dataset.a, rows = a.endsWith('all') ? [...c.querySelectorAll('li:not(.gone)')] : [bt.closest('li')];
    const did = a.startsWith('did');
    await withUndo(did ? 'Marked done' : 'Rescheduled missed', async () => {
      let moved = 0, dropped = 0;
      for (const row of rows) {
        const b = S.plan.find(x => x.id === row.dataset.id); row.classList.add('gone'); row.querySelectorAll('button').forEach(x => x.disabled = true);
        if (!b || b.status !== 'planned') continue;
        if (did) { b.status = 'done'; S.studied += mins(b); row.querySelector('.mbtns').textContent = '✓ done'; }
        else if (await rescheduleMissed(b)) { moved++; row.querySelector('.mbtns').textContent = `→ ${dLabel(b.date)} ${fmt(b.s)}`; }
        else { dropped++; row.querySelector('.mbtns').textContent = 'too late, skipped'; }
      }
      if (!did) remember('Sometimes misses sessions, so reschedules them');
      renderAll();
      if (!did) msg('bot', esc(`${moved ? `Moved ${moved} session${moved > 1 ? 's' : ''} to the next open time.` : ''}${dropped ? ` ${dropped} couldn't fit before ${dropped > 1 ? 'they\'re' : 'it\'s'} due, so I skipped ${dropped > 1 ? 'them' : 'it'}.` : ''}`.trim()));
      else if (rows.length > 1) msg('bot', 'Nice, all logged. 💪');
    });
    finish();
  });
}
function nextCard(quiet) {
  UI.inSession = false; UI.nextEl = null;
  let b = upcoming()[0];
  if (!b) { if (!quiet && S.plan.length) msg('bot', `That's every planned session done! 🎉 You put in ${hrs(S.studied)}. Proud of you.`); return; }
  const fitsPush = gaps(b.date, b.id).some(([a, z]) => a <= b.s + 0.5 + 1e-6 && z >= b.e + 0.5 - 1e-6);
  const nst = P.STYPES[P.stypeOf(b)];
  const c = card(`<h3>Up next: ${esc(b.title)}</h3><p class="muted" style="margin:0">${when(b)}${nst ? ` · ${nst.icon} ${esc(nst.label)}` : ''}</p>
    ${realTopics(b).length && !['project', 'writing', 'lab'].includes(P.stypeOf(b)) ? `<p class="muted small" style="margin:4px 0 0">${materialsFor(S, b.course, realTopics(b)).length ? `📎 The quiz will use your ${esc(materialsFor(S, b.course, realTopics(b)).slice(0, 2).map(m => m.name).join(' and '))}.` : `<button class="link" data-a="mats">📎 Add slides or notes so the quiz matches your class</button>`}</p>` : ''}
    <p class="todo"><b>What to do:</b> ${esc((b.focus || '').replace(/([^.!?])$/, '$1.'))}${nst && !['project', 'writing'].includes(P.stypeOf(b)) ? ` ${esc(nst.how)}` : ''}</p>
    <div class="q">Ready when it starts? You can also start it early.</div>
    <div class="btns" style="margin-top:0"><button class="btn" data-a="start">Start session</button>
    <button class="btn ghost" data-a="push" ${fitsPush ? '' : 'disabled title="No room right after it"'}>Give me 30 min</button>
    <button class="btn ghost" data-a="skip">Can't make it, move it</button>
    <button class="btn ghost" data-a="notneeded">Skip it, not needed</button></div>`);
  UI.nextEl = c;
  c.addEventListener('click', async e => {
    const a = e.target.closest('button')?.dataset.a; if (!a || e.target.disabled || UI.busy) return; lock(c); UI.nextEl = null;
    const cur = S.plan.find(x => x.id === b.id);
    if (!cur || cur.status !== 'planned') { msg('bot', 'Oops, that session isn\'t on your calendar anymore.'); return nextCard(true); }
    b = cur;
    if (a === 'start') { UI.week = mondayOf(b.date); buildCal(); return startSession(b); }
    if (a === 'push') {
      msg('user', 'Give me 30 min');
      await withUndo('Pushed 30 min', async () => { b.s += .5; b.e += .5; renderAll(); msg('bot', `Sure thing! Pushed it to ${fmt(b.s)}.${UI.google ? ' Your Google Calendar will update in a sec.' : ''}`); });
      return nextCard();
    }
    if (a === 'mats') { c.querySelectorAll('button').forEach(x => x.disabled = false); UI.nextEl = c; materialsCard(b.course, { topics: realTopics(b) }); return; }
    if (a === 'notneeded') {
      msg('user', 'Skip it, not needed');
      const it = itemById(b.itemId);
      const opts = [{ label: 'Just this session', value: 'one' }];
      if (it) opts.push({ label: `No prep for ${shortName(it)}`, value: 'item' });
      if (it && P.levelOf(it.course) !== 'light') opts.push({ label: `Less study time for ${it.course}`, value: 'light' });
      if (it) opts.push({ label: `No study time for ${it.course}`, value: 'none' });
      const v = await choose('What should I skip?', 'Skip just this one, or tell me it\'s not worth studying for at all.', opts);
      if (v === 'one') await withUndo('Skipped session', async () => { b.status = 'skipped'; remember('Skips sessions that aren\'t worth it'); renderAll(); msg('bot', 'Skipped. That time is yours.'); });
      if (v === 'item') await withUndo(`No prep: ${it.name}`, () => setItemPrep(it.id, false));
      if (v === 'light' || v === 'none') await withUndo(`${it.course} study time: ${LEVELS[v]}`, () => setCourseLevel(it.course, v));
      return nextCard();
    }
    if (a === 'skip') {
      msg('user', 'Can\'t make it, move it');
      await withUndo('Moved session', async () => {
        const r = P.relocate(b);
        if (!r) { b.status = 'skipped'; renderAll(); msg('bot', 'There\'s no open time left before it\'s due, so let\'s fold this into your next session. Totally doable.'); return; }
        b.date = r.d; b.s = r.s.s; b.e = r.s.e; UI.week = mondayOf(b.date); remember(`Skipped a ${tod(b.s).toLowerCase()} session once`); renderAll();
        msg('bot', `No stress, life happens. Moved it to ${when(b)}.${UI.google ? ' Google Calendar is updating.' : ` <a class="gc" href="${gcalLink(b)}" target="_blank" rel="noopener">＋ Add the new time to Google Calendar</a>`}`);
      });
      return nextCard();
    }
  });
}

// Sessions run in real time. The background worker keeps focus mode on and pings you when time's up,
// even if this tab is closed. Turn on "demo sessions" in Settings for 10-second sessions.
async function startSession(b) {
  const st = await loadSettings();
  if (SAFE) S.extras.focus = false;
  const dur = st.demoSessions ? 10e3 : mins(b) * 60e3;
  S.active = { id: b.id, start: Date.now(), end: Date.now() + dur };
  await saveState(S, 'app');
  await chrome.runtime.sendMessage({ type: 'session-start', end: S.active.end, focus: S.extras.focus });
  if (S.extras.focus) logTool('focus.block_sites', 'declarativeNetRequest', `${SITES.map(s => s.name).join(', ')} blocked`);
  runTimer(b);
}
function runTimer(b) {
  UI.inSession = true; $(b.id)?.classList.add('active');
  const quizP = makeQuiz(b);
  const c = card(`<h3>${esc(b.title)}</h3><div class="bigtimer">--:--</div><div class="track"><i></i></div>
    <p class="todo">${(() => { const t = P.STYPES[P.stypeOf(b)]; return t ? `<b>${t.icon} ${esc(t.label)}:</b> ` : ''; })()}${esc((b.focus || 'You\'ve got this').replace(/\.?$/, '.'))}${(() => { const k = P.stypeOf(b), t = P.STYPES[k]; return t && !['project', 'writing'].includes(k) ? ' ' + esc(t.how) : ''; })()}</p>
    <p class="muted" style="margin:6px 0 0">${S.extras.focus ? 'Distracting sites are blocked until the timer ends.' : ''}</p>
    <div class="btns"><button class="btn ghost" data-a="end">I'm done early</button></div>`);
  if (S.extras.focus) { $('focusText').textContent = `Focus mode on. ${SITES.slice(0, -1).map(s => s.name).join(', ')} and ${SITES.at(-1).name} are blocked.`; $('focusbar').classList.add('on'); }
  const total = S.active.end - S.active.start;
  let done = false;
  const finish = async () => {
    if (done) return; done = true;
    clearInterval(UI.timer); lock(c); $('focusbar').classList.remove('on'); $(b.id)?.classList.remove('active');
    await chrome.runtime.sendMessage({ type: 'session-stop' }).catch(() => {});
    if (S.extras.focus) logTool('focus.unblock_sites', 'declarativeNetRequest', 'sites unblocked');
    b.actualMin = Math.max(1, Math.round((Math.min(Date.now(), S.active.end) - S.active.start) / 60e3));
    S.active = null; await saveState(S, 'app');
    const quiz = await quizP;
    if (quiz) quizCard(b, quiz); else { msg('bot', 'No quiz this time. Straight to your check-in!'); checkIn(b, null); }
  };
  const tick = () => {
    const left = Math.max(0, S.active.end - Date.now());
    c.querySelector('.bigtimer').textContent = `${Math.floor(left / 60e3)}:${pad(Math.floor(left / 1e3) % 60)}`;
    c.querySelector('.track i').style.width = ((1 - left / total) * 100) + '%';
    if (left <= 0) finish();
  };
  c.querySelector('[data-a="end"]').onclick = finish; $('endBtn').onclick = finish;
  tick(); UI.timer = setInterval(tick, 500);
}
const realTopics = b => (b.topics || []).filter(t => !['Everything', 'Lecture notes', 'Practice problems', 'Key concepts'].includes(t));
async function makeQuiz(b) {
  const it = itemById(b.itemId), topics = realTopics(b), course = S.courses.find(c => c.code === b.course);
  if (it?.type === 'assignment' && !topics.length) return null;
  const kind = P.stypeOf(b), count = kind === 'pastexam' ? 5 : 3;
  const ctx = await contextFor(S, b.course, topics.length ? topics : P.keepTopics(b.course, it?.topics || []));
  try {
    const cs = P.isCS(b.course), lang = /python/i.test(`${course?.name} ${(course?.lectures || []).map(l => l.topic).join(' ')}`) ? 'Python' : /c\+\+/i.test(course?.name || '') ? 'C++' : 'Java';
    const csRule = cs ? ` This is a computer science course. Make at least 2 of the 3 questions code-based, in ${lang}: trace a short snippet (what it prints or returns), give the Big-O of a loop or method, or spot the bug. Put the code in "code" (at most 12 lines, no markdown fences) and use null for questions without code.` : '';
    const matRule = ctx.text ? ` The student's own course materials are below. Write every question from them: use the same terminology, notation, examples, and code style as the course, and stay within what they cover. If an old or practice exam is included, copy its question style and difficulty. In each explain, say where the answer comes from (like the slide or section title).` : '';
    const sys = `You write ${kind === 'pastexam' ? 'practice exam questions' : 'short practice quizzes'} for a college student. Return ONLY JSON: {"questions":[{"topic":string,"q":string,"code":string or null,"options":[4 strings],"answer":0-3,"explain":string}]}. Exactly ${count} multiple-choice questions for ${b.course}${course?.name ? ' (' + course.name + ')' : ''}, intro college level, on: ${topics.length ? topics.join(', ') : 'core material for ' + (it?.name || b.title)}. Cover each listed topic; "topic" must be one of them${topics.length ? '' : ' (use "General")'}. Factually correct, exactly one right answer. Question under 160 chars, options under 50, explain under 110. Vary the answer position.${csRule}${matRule}`;
    const p = await aiJSON(sys, `Session: ${b.title}. ${b.focus || ''}${ctx.text ? `\n\nCOURSE MATERIALS:\n${ctx.text}` : ''}`, { maxTokens: kind === 'pastexam' ? 3000 : 1800, schema: SCHEMA.quiz });
    const qs = (p.questions || []).filter(x => typeof x.q === 'string' && Array.isArray(x.options) && x.options.length === 4 && Number.isInteger(x.answer) && x.answer >= 0 && x.answer < 4).slice(0, count)
      .map(x => ({ ...x, code: typeof x.code === 'string' && x.code.trim() ? x.code.replace(/^```\w*\n?|```$/g, '').split('\n').slice(0, 14).join('\n').slice(0, 700) : null }));
    if (qs.length < Math.min(3, count)) throw 0;
    const tl = topics.length ? topics : ['General']; qs.forEach((x, i) => { if (!tl.includes(x.topic)) x.topic = tl[i % tl.length]; });
    setAI('live'); return { qs, live: true, sources: ctx.used };
  } catch (e) {
    // Offline: definition questions from the student's own notes first, then the built-in CS bank.
    const fromNotes = await notesQuiz(S, b.course, topics, count) || [];
    const cs = P.isCS(b.course) ? (csQuiz(topics) || []) : [];
    const mixed = [...fromNotes, ...cs].slice(0, Math.max(3, Math.min(count, fromNotes.length + cs.length)));
    if (mixed.length >= 2) { setAI('fallback'); return { qs: mixed, live: false, sources: fromNotes.length ? ctx.used : [] }; }
    const have = topics.filter(t => BANK[t]); if (!have.length) return null;
    const qs = have.length === 1 ? BANK[have[0]].map(x => ({ topic: have[0], q: x.q, options: x.o, answer: x.a, explain: x.x }))
      : have.slice(0, 3).map(t => { const x = BANK[t][Math.floor(Math.random() * 3)]; return { topic: t, q: x.q, options: x.o, answer: x.a, explain: x.x }; });
    setAI('fallback'); return { qs, live: false };
  }
}
function quizCard(b, quiz) {
  const qs = quiz.qs;
  msg('bot', `Nice work! Before you check in, quick quiz. ${qs.length} questions so we know where you really stand 🧠`);
  const c = card(`<h3>${P.stypeOf(b) === 'pastexam' ? 'Practice exam' : 'Quick check'}${quiz.live ? '' : quiz.sources?.length ? ' (from your notes, offline)' : ' (offline question bank)'}</h3>
    ${quiz.sources?.length ? `<p class="muted small" style="margin:0">📎 Based on ${esc(quiz.sources.slice(0, 3).join(', '))}</p>` : `<p class="muted small" style="margin:0"><button class="link qmat">📎 Add your slides or notes so quizzes match your class</button></p>`}
    ${qs.map((x, i) => `<div class="qq"><p>${i + 1}. ${esc(x.q).replace(/\n/g, '<br>')}</p>${x.code ? `<pre class="qcode"><code>${esc(x.code)}</code></pre>` : ''}${chips('q' + i, x.options)}<div class="ex" hidden></div></div>`).join('')}
    <div class="btns"><button class="btn save" disabled>Check answers</button></div>`);
  c.querySelectorAll('.qq').forEach(q => q.querySelectorAll('.chip').forEach((el, j) => el.dataset.v = String(j)));
  c.querySelector('.qmat')?.addEventListener('click', () => materialsCard(b.course, { topics: realTopics(b) }));
  const pick = chipGroup(c, p => { c.querySelector('.save').disabled = !qs.every((_, i) => p['q' + i] !== undefined); });
  c.querySelector('.save').onclick = () => {
    lock(c); const res = {}; let right = 0;
    c.querySelectorAll('.qq').forEach((el, i) => {
      const x = qs[i], ch = +pick['q' + i], ok = ch === x.answer; if (ok) right++;
      const cs = el.querySelectorAll('.chip'); cs.forEach(z => z.setAttribute('aria-pressed', 'false')); cs[x.answer].classList.add('right'); if (!ok) cs[ch].classList.add('wrong');
      const ex = el.querySelector('.ex'); ex.hidden = false; ex.textContent = (ok ? 'Correct. ' : 'Not quite. ') + x.explain;
      if (!ok) addExplain(ex, b.course, x.topic || realTopics(b)[0] || b.title, x, ch);
      res[x.topic] = res[x.topic] || [0, 0]; res[x.topic][1]++; if (ok) res[x.topic][0]++;
    });
    logTool('quiz.score', 'practice quiz', `${right} of ${qs.length} correct`);
    msg('bot', right === qs.length ? `${right} for ${right}! You clearly know this 🔥` : right >= 2 ? `${right} out of ${qs.length}, solid! Check the explanation on the one you missed.` : right === 1 ? '1 right. No worries, that\'s exactly why we quiz. Read the explanations above.' : '0 right, oof. Totally fine, now we know what to focus on.');
    const c2 = card(`<div class="btns" style="margin:0"><button class="btn">Continue to check-in</button></div>`);
    c2.querySelector('.btn').onclick = () => { lock(c2); checkIn(b, res); };
  };
}
function checkIn(b, quizRes) {
  const it = itemById(b.itemId);
  const topics = realTopics(b).length ? realTopics(b) : (it?.type === 'assignment' ? [] : ['Overall']);
  const c = card(`<h3>You made it through ${esc(b.title)}! How'd it go?</h3>
    <div class="q">Did you get through everything?</div>${chips('fin', ['Yes', 'Mostly', 'Not really'])}
    <div class="q">How was your focus?</div>${chips('focus', ['Locked in', 'Kinda distracted', 'Super distracted'])}
    ${topics.map((t, i) => `<div class="q">How confident do you feel about ${esc(t)}? 1 is totally lost, 5 is I could teach it</div>${chips('t' + i, ['1', '2', '3', '4', '5'])}`).join('')}
    ${b.kind === 'group' ? `<div class="q">Was studying with the group helpful?</div>${chips('grp', ['Super helpful', 'It was okay', 'Not really'])}` : ''}
    <div class="q">Anything trip you up? Optional</div><input class="field" placeholder="e.g. buffer problems">
    <div class="btns"><button class="btn save" disabled>Submit check-in</button></div>`);
  const pick = chipGroup(c, p => { c.querySelector('.save').disabled = !(p.fin && p.focus && (b.kind !== 'group' || p.grp) && topics.every((_, i) => p['t' + i])); });
  c.querySelector('.save').onclick = () => {
    const note = c.querySelector('input').value.trim(); lock(c);
    adapt(b, pick.fin, pick.focus, topics.map((t, i) => ({ t, v: +pick['t' + i] })), note, pick.grp, quizRes);
  };
}
async function adapt(b, fin, focus, scores, note, gfb, quizRes) {
  msg('user', esc(`${fin}. ${focus}.${scores.length ? ' ' + scores.map(s => `${s.t} ${s.v}/5`).join(', ') : ''}${note ? `. Hardest: ${note}` : ''}`));
  const f = fin === 'Yes' ? 1 : fin === 'Mostly' ? .6 : .3;
  const studied = Math.round((b.actualMin || mins(b)) * f); S.studied += studied; b.status = 'done';
  logTool('session.log', 'study history', `${studied} min, focus "${focus}"`);
  const snap = snapshot(), notes = [], it = itemById(b.itemId), key = t => `${b.itemId}|${t}`;
  for (const s of scores) {
    const q = quizRes && (quizRes[s.t] || (s.t === 'Overall' ? quizRes.General : null)); let comb = s.v;
    if (q) {
      const qc = 1 + 4 * q[0] / q[1]; comb = Math.max(1, Math.min(5, Math.round((s.v + qc) / 2))); S.quiz[key(s.t)] = `${q[0]}/${q[1]}`;
      recordProf(b.course, s.t, q[0], q[1], 'session quiz');
      if (comb < s.v) notes.push(esc(`You felt ${s.v}/5 on ${s.t}, but the quiz said otherwise, so I'm counting it as ${comb}/5 for now.`));
      else if (comb > s.v) notes.push(esc(`You did better on ${s.t} than you gave yourself credit for! Bumped it to ${comb}/5.`));
    }
    s.comb = comb; S.ready[key(s.t)] = comb;
  }
  if (b.kind === 'group' && gfb === 'Super helpful') { remember('Group reviews really help'); notes.push('Love that the group session clicked!'); }
  if (b.kind === 'group' && gfb === 'Not really') { remember('Group sessions are less productive than solo'); notes.push('Good to know. I\'ll keep the hard stuff solo.'); }
  if (focus === 'Super distracted') {
    remember(`Gets distracted during ${tod(b.s).toLowerCase()} sessions`);
    notes.push(S.extras.focus ? 'Even with focus mode, that one was tough. Try your phone in another room for the first 20 minutes.' : 'Want to turn on focus mode? It blocks YouTube and friends while you study.');
  }
  const lastOk = it ? lastDayFor(it) : b.date;
  for (const s of scores) {
    if (!it || it.type === 'assignment') break;
    const k = key(s.t);
    if (s.comb <= 2) {
      remember(`Needs extra practice on ${note || s.t}`);
      let placed = null;
      for (const d of weekdaysBetween(addDays(b.date, 1), lastOk)) { if (studyMinsOn(d) + S.prefs.len > P.DAILY_CAP) continue; const sl = findSlot(d, S.prefs.len); if (sl) { placed = blockFor(it, d, sl, `Extra: ${s.t}`, [s.t], 'extra', note || 'Added after your check-in'); break; } }
      if (placed) { placed.score = s.comb; S.plan.push(placed); S.srs[k] = { topic: s.t, interval: 1, label: dLabel(placed.date), onCal: true }; notes.push(esc(`${s.t} is at ${s.comb}/5, so I added an extra session ${when(placed)}.`)); }
      else { S.srs[k] = { topic: s.t, interval: 1, label: 'next session', onCal: false }; notes.push(esc(`${s.t} could use more love, but there's no open time before it's due. Let's start your next session with it.`)); }
      continue;
    }
    const prev = S.srs[k]?.interval || 0, interval = s.comb === 3 ? 1 : (b.kind === 'review' && prev ? prev * 3 : s.comb === 4 ? 3 : 6);
    let target = b.date; for (let i = 0; i < interval; i++) target = nextWeekday(addDays(target, 1));
    let placed = null;
    if (target <= lastOk && !S.plan.some(x => x.status === 'planned' && x.itemId === b.itemId && x.kind === 'review' && x.topics[0] === s.t)) {
      const sl = findSlot(target, 20); if (sl) { placed = blockFor(it, target, sl, `Quick review: ${s.t}`, [s.t], 'review', '20 minutes of flashcards and one practice problem'); placed.score = s.comb; S.plan.push(placed); }
    }
    logTool('srs.schedule', `${s.t}, every ${interval}d`, placed ? when(placed) : `queued for ${dLabel(target)}`);
    S.srs[k] = { topic: s.t, interval, label: dLabel(target), onCal: !!placed };
    if (placed) notes.push(esc(`I added a 20-minute spaced review of ${s.t} on ${dLabel(placed.date)}, since short reviews a day or two later make things stick.`));
    else if (s.comb >= 4) notes.push(esc(`${s.t} is looking strong. I'll bring it back around ${dLabel(target)} to keep it fresh.`));
  }
  S.plan.sort((a, b) => a.date.localeCompare(b.date) || a.s - b.s);
  renderAll();
  if (!notes.length) notes.push(scores.every(s => s.comb >= 4) ? 'Look at you go! 🔥 Plan stays the same.' : 'Solid work! I\'ll open your next session with a quick recap of this one.');
  msg('bot', notes.join(' ')); commitUndo(snap, 'Check-in changes'); nextCard();
}

/* ---------- surprise quiz + red ! alerts ---------- */
function openSurprise(prefill) {
  if (!S.courses.length) { toggle(true); msg('bot', 'Add a class first, then I can plan around surprise quizzes for it.'); return; }
  $('sqCourse').innerHTML = S.courses.map(c => `<option value="${esc(c.code)}">${esc(c.code)}${c.name ? ' ' + esc(c.name) : ''}</option>`).join('');
  if (prefill?.course && S.courses.some(c => c.code === prefill.course)) $('sqCourse').value = prefill.course;
  $('sqName').value = prefill?.name || 'Surprise quiz'; $('sqTopics').value = prefill?.topics || '';
  $('sqDate').min = today(); $('sqDate').value = prefill?.date || nextWeekday(addDays(today(), 1)); $('sqTime').value = prefill?.time || '';
  $('sqErr').hidden = true; $('sqModal').classList.add('on'); setTimeout(() => $('sqTopics').focus(), 50);
}
function closeSurprise() { $('sqModal').classList.remove('on'); $('sqBtn').focus(); }
$('sqBtn').onclick = () => openSurprise();
$('sqCancel').onclick = closeSurprise;
$('sqModal').addEventListener('click', e => { if (e.target === $('sqModal')) closeSurprise(); });
$('sqAdd').onclick = async () => {
  const date = $('sqDate').value, err = t => { $('sqErr').textContent = t; $('sqErr').hidden = false; };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err('Pick a date for the quiz.');
  if (date < today()) return err('That date already passed. Pick today or later.');
  if (UI.busy || UI.inSession) return err('Give me a sec, I\'m in the middle of something. Try again in a moment.');
  const q = { course: $('sqCourse').value, name: $('sqName').value.trim() || 'Surprise quiz', topics: $('sqTopics').value.split(/,|;|\band\b/).map(t => t.trim()).filter(Boolean).slice(0, 4), date, time: $('sqTime').value || null };
  closeSurprise(); UI.busy = true;
  try { await addSurpriseQuiz(q, false); } finally { UI.busy = false; }
};
async function addSurpriseQuiz(q, inChat) {
  const snap = snapshot();
  const r = P.mergeCourse({ source: 'chat', course: { code: q.course }, items: [{ name: q.name, type: 'quiz', date: q.date, time: q.time, topics: q.topics, surprise: true }] });
  const it = r.newItems[0];
  if (!it) return inChat ? 'Looks like that quiz is already on your list.' : undefined;
  logTool('tasks.add', `${it.course}: ${it.name}`, `${dLabel(it.date)}${it.time != null ? ' ' + fmt(it.time) : ''}`);
  let created = [];
  if (S.prefs) { created = P.surprisePrep(it); if (created.length) logTool('planner.schedule', 'surprise quiz prep', `${created.length} session${created.length > 1 ? 's' : ''} placed`); }
  renderAll(); commitUndo(snap, 'Surprise quiz');
  const w = relDay(it.date);
  const summary = !S.prefs ? `${it.course} ${it.name} is on your list for ${w}. Finish setup and I'll plan prep for it.`
    : created.length ? `I added ${created.length} prep session${created.length > 1 ? 's' : ''} for ${it.course} ${it.name} (${w})${UI.google ? ' to your Google Calendar' : ''}.`
    : `${it.course} ${it.name} is ${w}, but there's no free time before it. Skim your notes when you can!`;
  remember(`${it.course} has surprise quizzes`);
  raiseAlert(summary, created);
  return true;
}
function raiseAlert(summary, blocks) {
  S.alerts.push({ summary, ids: blocks.map(b => b.id), at: Date.now() }); S.fresh.push(...blocks.map(b => b.id)); UI.reviewShown = false;
  if (blocks[0]) UI.week = mondayOf(blocks[0].date);
  renderAll(); saveState(S, 'app').then(() => chrome.runtime.sendMessage({ type: 'state-changed' }).catch(() => {}));
  $('launch').classList.remove('alert'); void $('launch').offsetWidth; $('launch').classList.add('alert');
  if ($('chat').classList.contains('open')) { reviewCard(); return; }
  showAlertNudge(summary);
}
function showAlertNudge(summary) {
  $('nudge')?.remove();
  const nd = document.createElement('div'); nd.className = 'nudge alert'; nd.id = 'nudge'; nd.setAttribute('role', 'status');
  nd.innerHTML = `<b>Heads up!</b> ${esc(summary)} Tap to review.`; nd.onclick = () => toggle(true); document.body.appendChild(nd);
}
function reviewCard() {
  UI.reviewShown = true;
  const ids = S.alerts.flatMap(a => a.ids), blocks = S.plan.filter(b => ids.includes(b.id) && b.status === 'planned');
  const c = card(`<h3>❗ Your calendar changed</h3>
    ${S.alerts.map(a => `<p style="margin:6px 0 0;font-size:14px">${esc(a.summary)}</p>`).join('')}
    ${blocks.length ? `<p class="muted" style="margin:8px 0 0">New sessions have a red ! on your calendar${UI.google ? ' and are already on your "@me Study" Google Calendar' : '. Add them to Google Calendar so your phone reminds you too'}:</p>
    <ul class="slist">${blocks.map(b => `<li><span>${esc(b.title)}<small>${when(b)}</small></span>${UI.google ? '<span class="muted">✓ synced</span>' : `<a class="gc" href="${gcalLink(b)}" target="_blank" rel="noopener">＋ Add</a>`}</li>`).join('')}</ul>` : ''}
    <div class="btns">${blocks.length ? '<button class="btn ghost" data-a="show">Show me</button>' : ''}${UI.google ? `<a class="btn ghost" href="${gcal.calendarUrl()}" target="_blank" rel="noopener" style="text-decoration:none">Open Google Calendar</a>` : ''}<button class="btn" data-a="ok">Got it</button></div>`);
  c.classList.add('alertcard');
  c.addEventListener('click', e => {
    const a = e.target.closest('button')?.dataset.a; if (!a || e.target.disabled) return;
    if (a === 'show' && blocks[0]) { UI.week = mondayOf(blocks[0].date); buildCal(); blocks.forEach(b => $(b.id)?.classList.add('flash')); }
    if (a === 'ok') { lock(c); clearAlerts(); msg('user', 'Got it'); msg('bot', blocks.length ? 'Perfect. You\'ve got this, surprise or not 💪' : 'Okay! Good luck on it 🍀'); refreshNext(); }
  });
}
function clearAlerts() {
  S.alerts = []; S.fresh = []; UI.reviewShown = false; renderAll();
  saveState(S, 'app').then(() => chrome.runtime.sendMessage({ type: 'state-changed' }).catch(() => {}));
}

/* ---------- undo ---------- */
const CORE = ['courses', 'items', 'routine', 'oneoff', 'plan', 'prefs', 'extras', 'ready', 'quiz', 'srs', 'memory', 'studied', 'used', 'step', 'holidays', 'ignoredG', 'skipTopics', 'prof'];
const snapshot = () => JSON.stringify(Object.fromEntries(CORE.map(k => [k, S[k]])));
function commitUndo(snap, label) {
  if (snapshot() === snap) return;
  const i = UI.hist.push({ snap, label }) - 1;
  if (UI.hist.length > 30) UI.hist.shift();
  const btn = document.createElement('button'); btn.className = 'undo-btn'; btn.dataset.h = i; btn.textContent = `↶ Undo: ${label}`; btn.onclick = () => undoTo(+btn.dataset.h);
  $('stream').appendChild(btn); scroll(); renderUndo();
}
async function withUndo(label, fn) { const snap = snapshot(); await fn(); commitUndo(snap, label); }
function renderUndo() {
  const last = UI.hist.at(-1); $('undoBtn').disabled = !last;
  $('undoBtn').textContent = last ? `↶ Undo: ${last.label.length > 16 ? last.label.slice(0, 15) + '…' : last.label}` : '↶ Undo';
  $('undoBtn').title = last ? `Undo "${last.label}" (Ctrl+Z)` : 'Nothing to undo yet';
  document.querySelectorAll('.undo-btn').forEach(b => b.disabled = +b.dataset.h >= UI.hist.length);
}
async function undoTo(i, force) {
  toggle(true);
  if (UI.inSession) { msg('bot', 'Finish your session first, then you can undo stuff 😊'); return; }
  if ((UI.busy && !force) || !UI.hist[i]) return;
  const { snap, label } = UI.hist[i]; UI.hist.length = i;
  Object.assign(S, JSON.parse(snap)); document.querySelector('.pop')?.remove();
  if (S.alerts.length) { S.alerts = []; S.fresh = []; }
  renderAll(); renderUndo(); setStep(S.step);
  msg('bot', esc(`Undid "${label}". Everything's back how it was${UI.google ? ', and your Google Calendar will match in a moment' : ''}.`));
  document.querySelectorAll('#stream .card').forEach(lock); UI.nextEl = null;
  if (S.plan.some(b => b.status === 'planned')) nextCard(true);
  else if (!S.courses.length) addClassCard(true);
  else if (S.prefs) msg('bot', 'No plan right now. Just say "plan my week" whenever you\'re ready.');
  else afterClasses();
}
$('undoBtn').onclick = () => { if (UI.hist.length) undoTo(UI.hist.length - 1); };

/* ---------- daily briefing ---------- */
const briefDate = () => isWeekday(today()) && nowH() < 12 ? today() : nextWeekday(addDays(today(), 1));
async function showBriefing(date) {
  toggle(true); date = nextWeekday(date || briefDate());
  if (!S.courses.length) { msg('bot', 'Add a class first and I\'ll put together your daily briefing ☀️'); return; }
  const T = today(), isToday = date === T, from = isToday ? nowH() : 0;
  const list = [...eventsOn(date).map(e => ({ s: e.s, t: e.title + (e.kind === 'exam' ? ' 🎯' : ''), g: e.kind === 'gcal' })),
    ...S.plan.filter(b => b.date === date && b.status === 'planned').map(b => ({ s: b.s, t: `${b.title} (${mins(b)} min)`, study: 1 }))].filter(x => x.s >= from).sort((a, b) => a.s - b.s);
  const due = liveItems().filter(i => i.date === date && !(i.type === 'exam' && i.time != null));
  const soon = liveItems().filter(i => i.date > date && dayDiff(date, i.date) <= 4).sort((a, b) => a.date.localeCompare(b.date));
  const heads = [], x = liveItems().filter(i => i.type === 'exam' && i.date >= date).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (x) {
    const d = dayDiff(date, x.date);
    heads.push(d === 0 ? `${x.course} ${shortName(x)} is today at ${fmt(x.time ?? 9)}. Light review only, no cramming.` : d === 1 ? `${x.course} ${shortName(x)} is tomorrow${x.time != null ? ' at ' + fmt(x.time) : ''}.` : `${x.course} ${shortName(x)} is in ${d} days.`);
    const rated = (x.topics || []).map(t => [t, S.ready[x.id + '|' + t]]).filter(r => r[1]).sort((a, b) => a[1] - b[1]);
    if (rated.length && rated[0][1] <= 3) heads.push(`${rated[0][0]} is your shakiest topic for it (${rated[0][1]}/5).`);
  }
  const c = cutoff(date); heads.push(`Wrap up studying by ${fmt(c)}${c < S.extras.bedtime ? ' tonight so you\'re rested for tomorrow\'s exam' : ''}.`);
  const sc = list.filter(i => i.study).length;
  let pep = null;
  try {
    pep = (await ai('You are @me, a warm, casual study buddy. Write a 1 to 2 sentence morning pep line from this briefing data. Plain text, at most one emoji, under 200 characters, no greeting.',
      // Google Calendar event names never go to the AI; it only needs to know that time is busy.
      JSON.stringify({ date: dLabel(date), schedule: list.map(i => `${fmt(i.s)} ${i.g ? 'Busy' : i.t}`), due: due.map(i => i.name), heads }), { maxTokens: 200 })).trim();
    if (!pep || pep.length > 260) pep = null;
  } catch (e) { pep = null; }
  setAI(pep ? 'live' : 'fallback');
  pep = pep || (x && dayDiff(date, x.date) === 0 ? 'Exam day! You put in the work, so trust it. Eat breakfast and breathe 💪' : sc ? `You've got ${sc} study session${sc > 1 ? 's' : ''} lined up. Nice and steady.` : 'No study sessions today. Enjoy the breathing room!');
  const li = i => `<li><span class="t">${fmt(i.s)}</span><span>${esc(i.t)}</span></li>`;
  const cd = card(`<h3>${isToday && nowH() >= 12 ? 'Here\'s the rest of your day 🌙' : `Good morning! ☀️ Here's your ${dWeekday(date)}`}</h3>
    <p class="muted" style="margin:0">${dLabel(date)}. ${isToday ? '' : S.extras.brief ? `Your briefing notification arrives at ${fmt(S.extras.brief)}. This is a preview.` : 'Morning briefings are off. This is a preview.'}</p>
    <p class="pep">${esc(pep)}</p>
    <h4>On your calendar</h4><ul>${list.length ? list.map(li).join('') : '<li>Nothing scheduled. Free day!</li>'}</ul>
    ${due.length ? `<h4>Due ${isToday ? 'today' : 'that day'}</h4><ul>${due.map(i => `<li><span class="t">${i.time != null ? fmt(i.time) : '11:59 PM'}</span><span>${esc(i.course + ' ' + i.name)}</span></li>`).join('')}</ul>` : ''}
    ${soon.length ? `<h4>Coming up</h4><ul>${soon.map(i => `<li><span class="t">${DAYNAME[wkey(i.date)]} ${fromIso(i.date).getDate()}</span><span>${esc(i.course + ' ' + i.name)}</span></li>`).join('')}</ul>` : ''}
    <h4>Heads up</h4><ul>${heads.map(h => `<li><span>${esc(h)}</span></li>`).join('')}</ul>
    <div class="btns"><button class="btn" data-a="ok">Looks good</button><button class="btn ghost" data-a="move">Change something</button></div>`);
  cd.classList.add('brief');
  cd.addEventListener('click', e => {
    const a = e.target.closest('button')?.dataset.a; if (!a) return; lock(cd);
    if (a === 'ok') { msg('user', 'Looks good'); msg('bot', 'Awesome, have a great day! I\'ll remind you before each session.'); } else { $('input').value = 'Can you move my '; $('input').focus(); }
  });
}
$('briefBtn').onclick = () => showBriefing();

/* ---------- study settings (sidebar) ---------- */
async function applySettings(ch, fromChat) {
  const out = [];
  if (typeof ch.grades === 'boolean' && ch.grades !== S.extras.grades) { S.extras.grades = ch.grades; out.push(ch.grades ? 'grade weights on' : 'grade weights off'); }
  if (typeof ch.focus === 'boolean' && ch.focus !== S.extras.focus) { S.extras.focus = ch.focus; out.push(ch.focus ? 'focus mode on' : 'focus mode off'); }
  if ([22, 23, 24].includes(Number(ch.bedtime)) && Number(ch.bedtime) !== S.extras.bedtime) { S.extras.bedtime = Number(ch.bedtime); out.push(`done by ${fmt(S.extras.bedtime)}`); remember(`Done studying by ${fmt(S.extras.bedtime)}`); }
  if ([0, 7, 8, 9].includes(Number(ch.brief)) && Number(ch.brief) !== S.extras.brief) { S.extras.brief = Number(ch.brief); out.push(S.extras.brief ? `briefing at ${fmt(S.extras.brief)}` : 'briefing off'); }
  if (typeof ch.classCal === 'boolean' && ch.classCal !== !!S.extras.classCal) {
    if (ch.classCal && !UI.google) { renderSettings(); msg('bot', 'Connect Google Calendar first (top bar), then turn this on and I\'ll add your class schedule.'); return false; }
    S.extras.classCal = ch.classCal; out.push(ch.classCal ? 'classes on Google Calendar' : 'classes off Google Calendar');
  }
  if (typeof ch.dueCal === 'boolean' && ch.dueCal !== !!S.extras.dueCal) {
    if (ch.dueCal && !UI.google) { renderSettings(); msg('bot', 'Connect Google Calendar first (top bar), then turn this on and I\'ll add your deadlines.'); return false; }
    S.extras.dueCal = ch.dueCal; out.push(ch.dueCal ? 'deadlines on Google Calendar' : 'deadlines off Google Calendar');
  }
  if (['none', 'sat', 'sun', 'both'].includes(ch.weekends) && ch.weekends !== (S.extras.weekends || 'none')) { S.extras.weekends = ch.weekends; out.push({ none: 'no weekend studying', sat: 'Saturdays on', sun: 'Sundays on', both: 'weekends on' }[ch.weekends]); }
  if (['steady', 'late'].includes(ch.rhythm) && ch.rhythm !== (S.extras.rhythm || 'steady')) { S.extras.rhythm = ch.rhythm; out.push(ch.rhythm === 'late' ? 'rhythm: closer to deadlines' : 'rhythm: steady'); }
  if (typeof ch.termEnd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ch.termEnd) && ch.termEnd !== S.term?.end) { S.term = { ...(S.term || {}), end: ch.termEnd }; out.push(`semester ends ${dLabel(ch.termEnd)}`); }
  if (!out.length) { renderSettings(); return false; }
  logTool('settings.update', out.join(', '), 'saved');
  if (out.some(o => o.startsWith('briefing'))) chrome.runtime.sendMessage({ type: 'schedule-briefing' }).catch(() => {});
  if (out.some(o => o.startsWith('done by'))) {
    const r = P.resolveConflicts();
    if (r.moved.length) msg('bot', esc(`I moved ${r.moved.length} session${r.moved.length > 1 ? 's' : ''} so nothing runs past your new cutoff.`));
  }
  renderAll();
  if (S.plan.some(b => b.status === 'planned') && out.some(o => /weekend|Saturdays|Sundays|rhythm/.test(o))) setTimeout(async () => {
    const v = await choose('Re-plan with this?', 'Weekends and rhythm change where sessions go, so your plan needs a refresh to use them.', [{ label: 'Update my plan', value: 'y' }, { label: 'Not now', value: 'n' }]);
    if (v === 'y') { UI.busy = true; try { await withUndo('Updated plan', () => replan()); } finally { UI.busy = false; } }
  }, 200);
  if (!fromChat) msg('bot', esc(`Got it: ${out.join(', ')}.${S.plan.length && out.some(o => o.startsWith('grade')) ? ' Say "update my plan" if you want me to re-balance sessions with that.' : ''}`));
  return true;
}
const settingUndo = ch => withUndo('Settings change', () => applySettings(ch));
$('setGrades').onchange = e => { if (UI.busy) { renderSettings(); return; } toggle(true); settingUndo({ grades: e.target.checked }); };
$('setFocus').onchange = e => { if (UI.busy) { renderSettings(); return; } toggle(true); settingUndo({ focus: e.target.checked }); };
$('setBed').onchange = e => { if (UI.busy) { renderSettings(); return; } toggle(true); settingUndo({ bedtime: Number(e.target.value) }); };
$('setBrief').onchange = e => { if (UI.busy) { renderSettings(); return; } toggle(true); settingUndo({ brief: Number(e.target.value) }); };
$('setWeekend').onchange = e => { if (UI.busy) { renderSettings(); return; } toggle(true); settingUndo({ weekends: e.target.value }); };
$('setRhythm').onchange = e => { if (UI.busy) { renderSettings(); return; } toggle(true); settingUndo({ rhythm: e.target.value }); };
$('setDueCal').onchange = e => { if (UI.busy) { renderSettings(); return; } toggle(true); settingUndo({ dueCal: e.target.checked }); };
$('setClassCal').onchange = e => { if (UI.busy) { renderSettings(); return; } toggle(true); settingUndo({ classCal: e.target.checked }); };
$('setTermEnd').onchange = e => { if (UI.busy) { renderSettings(); return; } toggle(true); settingUndo({ termEnd: e.target.value }); };

/* ---------- open-ended chat ---------- */
function refreshNext() { if (UI.inSession || !S.prefs) return; if (UI.nextEl) { lock(UI.nextEl); UI.nextEl = null; } nextCard(true); }
async function planNewItems() {
  if (!S.prefs || !S.plan.length) return;
  const r = P.buildPlan(); if (!r.created.length) return;
  logTool('planner.schedule', 'new deadlines only', `${r.created.length} sessions placed`); renderAll();
  msg('bot', esc(`I added ${r.created.length} study session${r.created.length > 1 ? 's' : ''} for that.`)); await gcalCard(r.created, false);
}
const findItem = (id, name) => S.items.find(i => i.id === id) || (name ? S.items.find(i => i.status !== 'cancelled' && i.name.toLowerCase().includes(String(name).toLowerCase())) : null);
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
async function exec(a) {
  const findB = id => S.plan.find(b => b.id === id && b.status === 'planned');
  switch (a.type) {
    case 'make_plan': case 'replan':
      if (!S.courses.length) return 'Add a class first, then I can plan.';
      if (!S.prefs) { afterClasses(); return true; }
      if (S.plan.some(b => b.status === 'planned')) await replan(); else await planAll(); return true;
    case 'import_schedule': scheduleCard(); return true;
    case 'add_class':
      if (a.via === 'canvas') canvasImport(); else sylCard(); return true;
    case 'add_busy': {
      const s = parseHM(a.start) ?? Number(a.start), e = parseHM(a.end) ?? Number(a.end); if (!(e > s)) return false;
      const course = S.courses.find(c => c.code.toLowerCase() === String(a.course || '').toLowerCase())?.code;
      const title = String(a.title || (course ? `${course} class` : 'Busy')).slice(0, 24);
      if (Array.isArray(a.days) && a.days.length) {
        const days = a.days.map(d => String(d).slice(0, 3).toLowerCase()).filter(d => WK.includes(d)); if (!days.length) return false;
        S.routine.push({ id: uid('r'), title, days, s, e, course }); logTool('routine.add', `${title} ${daysTxt(days)}`, `${fmt(s)} to ${fmt(e)} every week`);
      } else if (isDate(a.date)) { S.oneoff.push({ id: uid('o'), title, date: a.date, s, e }); logTool('busy.add', title, `${dLabel(a.date)} ${fmt(s)} to ${fmt(e)}`); }
      else return false;
      const r = P.resolveConflicts(); renderAll();
      if (r.moved.length) msg('bot', esc(`That overlapped ${r.moved.length} study session${r.moved.length > 1 ? 's' : ''}, so I moved ${r.moved.length > 1 ? 'them' : 'it'}: ${r.moved.map(b => `${b.title} to ${when(b)}`).join('; ')}.`));
      if (r.dropped.length) msg('bot', esc(`I couldn't find new times for ${r.dropped.map(b => b.title).join(', ')}, so I took ${r.dropped.length > 1 ? 'them' : 'it'} off.`));
      return true;
    }
    case 'add_item': {
      if (!a.name || !isDate(a.date)) return false;
      const r = P.mergeCourse({ source: 'chat', course: { code: a.course || 'Personal' }, items: [{ name: a.name, type: a.type, date: a.date, time: a.time, weight: a.weight, topics: a.topics }] });
      logTool('tasks.add', `${r.code}: ${a.name}`, dLabel(a.date)); renderAll(); await planNewItems(); return true;
    }
    case 'cancel_item': {
      const it = findItem(a.id, a.name); if (!it || it.status === 'cancelled') return false;
      it.status = 'cancelled'; const gone = S.plan.filter(b => b.itemId === it.id && b.status === 'planned'); gone.forEach(b => b.status = 'removed');
      logTool('tasks.cancel', `${it.course} ${it.name}`, `removed${gone.length ? ` with ${gone.length} study session${gone.length > 1 ? 's' : ''}` : ''}`);
      remember(`${it.course} ${it.name} was cancelled`); renderAll();
      if (gone.length) msg('bot', esc(`I cleared the ${gone.length} study session${gone.length > 1 ? 's' : ''} for it${UI.google ? ' from Google Calendar too' : ''}. Hit undo if you want them back.`));
      return true;
    }
    case 'move_item': {
      const it = findItem(a.id, a.name); if (!it || !isDate(a.date)) return false;
      const sameDay = it.date === a.date;
      it.date = a.date; if (a.time != null) it.time = parseHM(a.time) ?? it.time;
      logTool('tasks.update', `${it.course} ${it.name}`, `now ${dLabel(it.date)}${it.time != null ? ', ' + fmt(it.time) : ''}`);
      if (sameDay) { renderAll(); return true; }      // only the time changed, so the study plan still fits
      S.plan.filter(b => b.itemId === it.id && b.status === 'planned').forEach(b => b.status = 'removed');
      renderAll(); await planNewItems(); return true;
    }
    case 'remove_session': {
      const list = a.id === 'all' ? S.plan.filter(b => b.status === 'planned') : [findB(a.id)].filter(Boolean); if (!list.length) return false;
      list.forEach(b => b.status = 'removed'); logTool('plan.remove', `${list.length} session${list.length > 1 ? 's' : ''}`, 'removed'); renderAll(); return true;
    }
    case 'move_session': {
      const b = findB(a.id); if (!b || !isDate(a.date)) return false;
      const st = parseHM(a.start) ?? Number(a.start), len = mins(b) / 60; if (!(st >= START)) return false;
      if (!gaps(a.date, b.id).some(([x, z]) => x <= st + 1e-6 && z >= st + len - 1e-6)) return `That time doesn't work for "${b.title}". It either clashes with something or runs past your ${fmt(cutoff(a.date))} cutoff.`;
      b.date = a.date; b.s = st; b.e = st + len; UI.week = mondayOf(b.date); renderAll(); return true;
    }
    case 'add_session': {
      if (!S.prefs || !isDate(a.date)) return false;
      const it = findItem(a.itemId, a.item) || nextExam(); const len = Number(a.len) || S.prefs.len;
      const st = parseHM(a.start) ?? Number(a.start); let slot = null;
      if (st >= START) { if (gaps(a.date).some(([x, z]) => x <= st + 1e-6 && z >= st + len / 60 - 1e-6)) slot = { s: st, e: st + len / 60 }; }
      else slot = findSlot(a.date, len);
      if (!slot) return `I couldn't fit that on ${dLabel(a.date)} without clashing or cutting into your sleep.`;
      const b = blockFor(it || { id: null, course: '' }, a.date, slot, String(a.title || 'Study session'), a.topic ? [a.topic] : [], 'study', a.focus || 'Added from chat');
      if (a.why) b.why0 = String(a.why).slice(0, 100);
      S.plan.push(b); UI.week = mondayOf(b.date); renderAll(); return true;
    }
    case 'update_prefs': {
      if (!S.prefs) return false; const ch = [];
      if (['Morning', 'Afternoon', 'Evening'].includes(a.time)) { S.prefs.time = a.time; ch.push(`Studies best in the ${a.time.toLowerCase()}`); }
      if ([45, 60, 90].includes(Number(a.len))) { S.prefs.len = Number(a.len); ch.push(`Prefers ${a.len} min sessions`); }
      if (Number(a.goal) > 0 && Number(a.goal) < 40) { S.prefs.goal = Number(a.goal); ch.push(`Weekly goal: ${a.goal}h`); }
      if (typeof a.group === 'boolean') { S.prefs.group = a.group; ch.push(a.group ? 'Likes some group studying' : 'Prefers studying solo'); }
      if (!ch.length) return false; ch.forEach(remember); renderAll(); return true;
    }
    case 'update_settings': return await applySettings(a, true);
    case 'course_study_level': {
      const c = S.courses.find(x => x.code.toLowerCase() === String(a.course || '').toLowerCase()) || S.courses.find(x => String(a.course || '').toLowerCase().includes(x.code.toLowerCase().split(' ')[0]));
      if (!c) return `I couldn't find a class called ${a.course}.`;
      return (await setCourseLevel(c.code, String(a.level || '').toLowerCase())) || `${c.code} is already on ${LEVELS[c.priority || 'normal']} study time.`;
    }
    case 'item_prep': {
      const it = findItem(a.id, a.name); if (!it) return `I couldn't find "${a.name || a.id}" in Upcoming.`;
      return (await setItemPrep(it.id, !!a.prep)) || `${it.name} is already set that way.`;
    }
    case 'google_extras': await offerGoogleExtras(true); return true;
    case 'help': showHelp(); return true;
    case 'self_check': { const f = findTopic(a.topic, S.courses.find(c => c.code.toLowerCase() === String(a.course || '').toLowerCase())?.code); if (!f) return `I couldn't find a topic called "${a.topic}".`; await selfCheck(f.code, f.t); return true; }
    case 'proficiency': {
      const c = S.courses.find(x => x.code.toLowerCase() === String(a.course || '').toLowerCase()) || S.courses.find(x => x.code === UI.profCourse) || S.courses[0];
      if (!c) return 'Add a class first.';
      UI.profCourse = c.code; S.profCollapsed = false; renderProficiency(); persist();
      const rows = profRows(c.code), tested = rows.filter(r => r.p?.pct != null).sort((x, y) => x.p.pct - y.p.pct);
      if (!tested.length) { msg('bot', esc(`You haven't been tested on any ${c.code} topics yet. Hit "Check" next to a topic in the Proficiency panel, or say "test me on ${rows[0]?.t || 'recursion'}".`)); return true; }
      const avg = Math.round(tested.reduce((x, r) => x + r.p.pct, 0) / tested.length);
      msg('bot', esc(`${c.code}: ${avg}% overall (${levelOfPct(avg).name}) across ${tested.length} tested topic${tested.length > 1 ? 's' : ''}. Strongest: ${tested.at(-1).t} (${tested.at(-1).p.pct}%). ${tested[0].p.pct < 70 ? `Work on ${tested[0].t} next (${tested[0].p.pct}%).` : 'Nothing below proficient. Nice!'}${rows.length > tested.length ? ` ${rows.length - tested.length} topics aren't tested yet.` : ''}`));
      return true;
    }
    case 'practice': { practiceCard(practiceTarget({ id: a.id, name: a.name }), { topics: a.topics, count: [5, 10, 15].includes(+a.count) ? +a.count : undefined, source: ['notes', 'topics'].includes(a.source) ? a.source : undefined }); return true; }
    case 'add_materials': { const c = S.courses.find(x => x.code.toLowerCase() === String(a.course || '').toLowerCase()); materialsCard(c?.code); return true; }
    case 'topic_importance': {
      const course = S.courses.find(c => c.code.toLowerCase() === String(a.course || '').toLowerCase())?.code
        || S.courses.find(c => [...(c.lectures || []).map(l => l.topic), ...S.items.filter(i => i.course === c.code).flatMap(i => i.topics || [])].some(t => t.toLowerCase() === String(a.topic || '').toLowerCase()))?.code;
      if (!course) return `I couldn't tell which class "${a.topic}" belongs to.`;
      const all = [...new Set([...(S.courses.find(c => c.code === course)?.lectures || []).map(l => l.topic), ...S.items.filter(i => i.course === course).flatMap(i => i.topics || [])])];
      const topic = all.find(t => t.toLowerCase() === String(a.topic || '').toLowerCase()) || all.find(t => t.toLowerCase().includes(String(a.topic || '').toLowerCase()));
      if (!topic) return `I couldn't find a topic called "${a.topic}" in ${course}.`;
      return (await setTopicImportance(course, topic, !!a.important)) || `${topic} is already marked ${a.important ? 'important' : 'not important'}.`;
    }
    case 'remove_course': {
      const c = S.courses.find(x => x.code.toLowerCase() === String(a.course || '').toLowerCase()); if (!c) return false;
      const n = P.removeCourse(c.code); logTool('classes.remove', c.code, `removed with ${n} item${n !== 1 ? 's' : ''}`); renderAll(); return true;
    }
    case 'show_briefing': await showBriefing(isDate(a.date) ? a.date : undefined); return true;
    case 'surprise_quiz': {
      if (!S.courses.length) return 'Add a class first, then I can handle surprise quizzes for it.';
      const course = S.courses.find(c => c.code.toLowerCase() === String(a.course || '').toLowerCase())?.code || S.courses[0].code;
      if (!isDate(a.date) || a.date < today()) { openSurprise({ course, topics: (a.topics || []).join(', ') }); return true; }
      return await addSurpriseQuiz({ course, name: String(a.name || 'Surprise quiz').slice(0, 40), topics: (Array.isArray(a.topics) ? a.topics : []).map(String).slice(0, 4), date: a.date, time: a.time || null }, true);
    }
    case 'check_canvas': {
      const r = await chrome.runtime.sendMessage({ type: 'poll-now' });
      return r?.ok ? (r.found ? true : 'I checked Canvas and there\'s nothing new. You\'re all caught up!') : `I couldn't check Canvas: ${r?.reason || 'unknown error'}.`;
    }
    case 'undo': if (!UI.hist.length) return 'There\'s nothing to undo yet.'; UI.undoAfter = true; return true;
  }
  return false;
}
function fallbackIntent(t) {
  const low = t.toLowerCase(), T = today();
  if (/(review|practice|prep(are)?|study|quiz me|drill)\b.*\b(midterm|exam|final|test|quiz)|practice (problems|questions|exam|test)|quiz me( on)?|mock exam/.test(low) && !/(cancel|moved|postpon|no prep|don'?t need)/.test(low)) {
    const it = practiceTarget({ name: low });
    const tps = it ? courseTopics(it.course).filter(t => low.includes(t.toLowerCase())) : [];
    return { reply: '', actions: [{ type: 'practice', id: it?.id, topics: tps, source: /(notes|slides)/.test(low) ? 'notes' : null }] };
  }
  if (/^\s*(help|\?|commands)\s*$|what can (you|@me|atme) do|how (do i|does this) work|what (are|do) (your )?(commands|features)/.test(low)) return { reply: '', actions: [{ type: 'help' }] };
  // "my final is at 8am", "the CS 0445 final is Dec 14 at 3:30pm"
  const fm = /\bfinal\b/.test(low) && low.match(/(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (fm) {
    const course = S.courses.find(c => low.includes(c.code.toLowerCase()));
    const fin = liveItems().filter(i => P.isFinal(i) && i.date >= addDays(today(), -1) && (!course || i.course === course.code)).sort((x, y) => x.date.localeCompare(y.date))[0];
    if (fin) {
      let h = +fm[1] % 12 + (fm[3] === 'pm' ? 12 : 0); const time = `${String(h).padStart(2, '0')}:${fm[2] || '00'}`;
      const dm = low.match(/\b(\d{1,2})\/(\d{1,2})\b/) || null;
      const mon = low.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/);
      const M = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
      const mo = dm ? +dm[1] : mon ? M[mon[1]] : null, dd = dm ? +dm[2] : mon ? +mon[2] : null;
      const date = mo ? `${fin.date.slice(0, 4)}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}` : fin.date;
      return { reply: `Got it: ${fin.course} ${fin.name}, ${dLabel(date)} at ${fmt(h + (+(fm[2] || 0)) / 60)}.`, actions: [{ type: 'move_item', id: fin.id, date, time }] };
    }
  }
  if (/how am i doing|my (scores?|proficiency|progress)|what('?s| is) my weakest|where am i weak/.test(low)) return { reply: '', actions: [{ type: 'proficiency', course: S.courses.find(c => low.includes(c.code.toLowerCase()))?.code }] };
  const sc = low.match(/(?:test me on|self[- ]?check(?: on| my)?|check (?:me on|my)|how well do i know)\s+(.+?)[?.!]*$/);
  if (sc && findTopic(sc[1])) return { reply: '', actions: [{ type: 'self_check', topic: sc[1] }] };
  if (/what'?s due|due (this|next) week|upcoming deadlines|what do i have (due|coming up)/.test(low)) {
    const T = today(), next = /next week/.test(low), from = next ? addDays(mondayOf(T), 7) : T, to = next ? addDays(from, 6) : addDays(T, 6);
    const due = liveItems().filter(i => i.date >= from && i.date <= to).sort((x, y) => x.date.localeCompare(y.date) || (x.time ?? 24) - (y.time ?? 24));
    return { reply: due.length ? `${next ? 'Next week' : 'In the next 7 days'}: ${due.map(i => `${i.course} ${i.name} (${dLabel(i.date)}${i.time != null ? ', ' + fmt(i.time) : ''})`).join('; ')}.` : `Nothing is due ${next ? 'next week' : 'in the next 7 days'}. 🎉`, actions: [] };
  }
  if (/^\s*undo|undo (that|it|this)|take (that|it) back|change it back/.test(low)) return { reply: '', actions: [{ type: 'undo' }] };
  if (/brief|my day|what'?s (on )?(today|tomorrow)|tomorrow look|today look/.test(low)) return { reply: 'Here you go! ☀️', actions: [{ type: 'show_briefing', date: /tomorrow/.test(low) ? nextWeekday(addDays(T, 1)) : /today/.test(low) && isWeekday(T) ? T : undefined }] };
  if (/surprise|pop quiz/.test(low)) return { reply: 'Ooh, a surprise one! Tell me the details 😬', actions: [{ type: 'surprise_quiz', course: (S.courses.find(c => low.includes(c.code.toLowerCase()) || low.includes(c.code.split(' ')[0].toLowerCase())) || {}).code, date: /tomorrow/.test(low) ? nextWeekday(addDays(T, 1)) : null }] };
  if (/(class|lecture|course)\s*(times|schedule)?.*(google|calendar)|(assignments?|deadlines?|due dates?|exams?).*(google|calendar)/.test(low) && /(add|put|import|sync|show)/.test(low)) return { reply: '', actions: [{ type: 'google_extras' }] };
  const lvl = low.match(/(?:don'?t|do not|no) (?:need to )?(?:study|prep(?:are)?) (?:for )?(?:my )?([a-z]{2,7}\s?\d{3,4})|([a-z]{2,7}\s?\d{3,4}) (?:doesn'?t|does not) need (?:study|studying|prep)|(?:less|light) (?:study(?:ing)?|prep) (?:for )?([a-z]{2,7}\s?\d{3,4})/);
  if (lvl) { const code = (lvl[1] || lvl[2] || lvl[3]).replace(/\s/g, ''); const c = S.courses.find(x => x.code.toLowerCase().replace(/\s/g, '') === code); if (c) return { reply: '', actions: [{ type: 'course_study_level', course: c.code, level: lvl[3] ? 'light' : 'none' }] }; }
  if (/(add|upload|use|attach|import)\b.*\b(slides?|notes|study guide|old exams?|practice exams?|powerpoint|lecture slides)/.test(low)) { const c = S.courses.find(x => low.includes(x.code.toLowerCase()) || low.includes(x.code.split(' ')[0].toLowerCase())); return { reply: '', actions: [{ type: 'add_materials', course: c?.code || null }] }; }
  const imp = t.match(/^\s*(.+?)\s+(?:isn'?t|is not|not)\s+(?:important|on the (?:exam|test)|needed)|(?:don'?t|do not|no) (?:need to )?(?:study|prep(?:are)?|prepare) (?:for )?(.+?)\s*$|(.+?)\s+(?:is|matters?)\s+important(?: again)?\s*$/i);
  if (imp && S.courses.some(c => c.lectures?.length)) {
    const name = (imp[1] || imp[2] || imp[3] || '').replace(/^(the|my)\s+/i, '').replace(/[.!?]+$/, '').trim();
    if (name.length >= 3) return { reply: '', actions: [{ type: 'topic_importance', topic: name, important: !!imp[3] }] };
  }
  const drop = low.match(/(?:remove|drop|delete|dropped)\s+(?:my\s+)?(?:class\s+)?([a-z]{2,7}\s?\d{3,4})/);
  if (drop) { const c = S.courses.find(x => x.code.toLowerCase().replace(/\s/g, '') === drop[1].replace(/\s/g, '')); if (c) return { reply: `Done, I removed ${c.code}. Hit undo if that was a mistake.`, actions: [{ type: 'remove_course', course: c.code }] }; }
  if (/class (schedule|times)|schedule screenshot|my schedule/.test(low) && !parseRoutine(t).length) return { reply: 'Let\'s get your class times in!', actions: [{ type: 'import_schedule' }] };
  if (/lecture|what.*(cover|topic)|class (this|next) week/.test(low) && S.courses.some(c => c.lectures?.length)) {
    const T2 = today(), up = S.courses.flatMap(c => (c.lectures || []).filter(l => l.date >= T2).slice(0, 3).map(l => `${c.code} ${dLabel(l.date)}: ${l.topic}`));
    return { reply: up.length ? `Coming up: ${up.join('; ')}.` : 'No upcoming lectures on file.', actions: [] };
  }
  if (/check canvas|anything new|new on canvas/.test(low)) return { reply: 'Checking Canvas…', actions: [{ type: 'check_canvas' }] };
  if (/syllabus/.test(low)) return { reply: 'Let\'s do it!', actions: [{ type: 'add_class', via: 'syllabus' }] };
  if (/canvas/.test(low)) return { reply: 'On it!', actions: [{ type: 'add_class', via: 'canvas' }] };
  if (/weekend|saturday|sunday/.test(low) && /(study|plan|sessions?|work)/.test(low)) {
    const off = /(no|not|don'?t|stop|without)\b.*weekend|weekends? off/.test(low);
    const v = off ? 'none' : /saturday/.test(low) && !/sunday/.test(low) ? 'sat' : /sunday/.test(low) && !/saturday/.test(low) ? 'sun' : 'both';
    return { reply: off ? 'Got it, weekends stay free.' : 'Got it, weekends are open for studying now.', actions: [{ type: 'update_settings', weekends: v }] };
  }
  if (/(closer to|last minute|near) (the )?(deadline|exam|due)|cram/.test(low)) return { reply: 'Okay, I\'ll keep prep closer to deadlines.', actions: [{ type: 'update_settings', rhythm: 'late' }] };
  if (/(spread|steady|earlier|start early)/.test(low) && /(study|prep|plan)/.test(low)) return { reply: 'Okay, I\'ll spread prep out earlier.', actions: [{ type: 'update_settings', rhythm: 'steady' }] };
  if (/focus mode|block (sites|youtube|distract)/.test(low)) { const off = /off|disable|stop|don'?t/.test(low); return { reply: off ? 'Done, focus mode is off.' : 'Done, focus mode is on 🔒', actions: [{ type: 'update_settings', focus: !off }] }; }
  const bed = low.match(/(?:bed|sleep|done by|stop (?:at|by))\D*(10|11|12|midnight)/);
  if (bed) { const v = { '10': 22, '11': 23, '12': 24, 'midnight': 24 }[bed[1]]; return { reply: `Got it, no studying after ${fmt(v)}. Sleep is part of studying too 😴`, actions: [{ type: 'update_settings', bedtime: v }] }; }
  const rt = parseRoutine(t);
  if (rt.length) return { reply: `Got it! Adding ${rt.map(x => `${x.title} ${daysTxt(x.days)} ${fmt(x.s)} to ${fmt(x.e)}`).join(' and ')} to your week.`, actions: rt.map(x => ({ type: 'add_busy', title: x.title, course: x.course, days: x.days, start: toHM(x.s), end: toHM(x.e) })) };
  if (/cancel|called off|no (more )?(exam|quiz)|isn'?t happening/.test(low)) {
    const it = liveItems().filter(i => i.date >= T).find(i => low.includes(i.name.toLowerCase().split(':')[0])) || (/quiz/.test(low) ? liveItems().filter(i => i.type === 'quiz' && i.date >= T).sort((a, b) => a.date.localeCompare(b.date))[0] : nextExam());
    if (it) return { reply: `Wait, seriously? ${it.course} ${shortName(it)} is off? 🎉 I took it off your plan.`, actions: [{ type: 'cancel_item', id: it.id }] };
  }
  if (/(update|re-?plan|redo|rebalance).*(plan|schedule)|(plan|schedule) again/.test(low)) return { reply: '', actions: [{ type: 'replan' }] };
  if (/plan|schedul|study time|my week/.test(low)) return { reply: '', actions: [{ type: 'make_plan' }] };
  const fb = !UI.aiOk ? 'I can do a lot more once you add a free Gemini key in Settings. For now, try "plan my week", "I work Tue and Thu 2-6pm", or "what does tomorrow look like?".'
    : !S.courses.length ? 'Happy to chat! First, add a class with a syllabus or Canvas so I can actually help you plan.'
    : `I couldn't reach ${UI.aiName} just now, so I can only handle simple requests. Try "plan my week", "my quiz got cancelled", or "what does tomorrow look like?".`;
  return { reply: fb, actions: [] };
}
async function chat(text) {
  if (/^\s*(help|\?|commands)\s*$|what can (you|@me|atme) do/i.test(text)) { showHelp(); return; }
  const snap = snapshot(); UI.undoAfter = false;
  const th = msg('bot', '<span class="muted">Hmm, let me think…</span>');
  const T = today();
  const sys = `You are @me, a friendly, casual study buddy who's great at planning: supportive, never preachy, at most one emoji. Today is ${dWeekday(T)}, ${T}, ${fmt(nowH())}. The calendar is Monday to Friday${S.extras.weekends && S.extras.weekends !== 'none' ? ' plus weekend days the student allowed' : ''}.${UI.google ? ' Study sessions sync to the student\'s "@me Study" Google Calendar automatically.' : ''}
Return ONLY JSON, no markdown: {"reply": string, "actions": [action, ...]}.
Actions (only when the user clearly wants it; else an empty array; if unclear, ask a short question instead):
{"type":"make_plan"} plan study time for the next 3 weeks ("replan" if a plan exists and they want it redone)
{"type":"replan"}
{"type":"add_class","via":"syllabus"|"canvas"}
{"type":"add_busy","title":string,"course":string or null,"days":["mon"..."sun"] for weekly things OR "date":"YYYY-MM-DD" for one-offs,"start":"HH:MM","end":"HH:MM"} (work, practice, appointments, or class meeting times; set course for a class). The app moves conflicting sessions automatically.
{"type":"add_item","course":string,"name":string,"type":"exam"|"quiz"|"assignment","date":"YYYY-MM-DD","time":"HH:MM" or null,"weight":number or null,"topics":[string]}
{"type":"cancel_item","id":string}
{"type":"move_item","id":string,"date":"YYYY-MM-DD","time":"HH:MM" or null}
{"type":"remove_session","id":string or "all"}
{"type":"move_session","id":string,"date":"YYYY-MM-DD","start":"HH:MM"}
{"type":"add_session","date":"YYYY-MM-DD","start":"HH:MM" or null,"len":minutes,"title":string,"itemId":string,"topic":string,"why":string}
{"type":"update_prefs","time":"Morning"|"Afternoon"|"Evening","len":45|60|90,"goal":number,"group":boolean} only changed fields
{"type":"update_settings","grades":boolean,"focus":boolean,"bedtime":22|23|24,"brief":0|7|8|9,"classCal":boolean,"dueCal":boolean,"weekends":"none"|"sat"|"sun"|"both","rhythm":"steady"|"late","termEnd":"YYYY-MM-DD"} only changed fields; classCal puts class times on Google Calendar, dueCal puts deadlines there, rhythm late means prep closer to deadlines
{"type":"show_briefing","date":"YYYY-MM-DD"}
{"type":"surprise_quiz","course":string,"name":string,"topics":[string],"date":"YYYY-MM-DD" or null,"time":"HH:MM" or null} a surprise or pop quiz was announced; null date if unknown (the app opens a form)
{"type":"check_canvas"} check Canvas for anything new right now
{"type":"import_schedule"} they want to add class times from their schedule (opens the paste or screenshot card); for one class with clear times, use add_busy with course instead
{"type":"remove_course","course":string} they dropped a class or it was imported by mistake
{"type":"course_study_level","course":string,"level":"normal"|"light"|"none"} how much study time a whole class gets; use none when they say a class doesn't need studying (like a gen-ed outside their major), light for less
{"type":"item_prep","id":string,"prep":boolean} prep false when one exam, quiz, or assignment doesn't need study time
{"type":"google_extras"} they want class times or assignments on Google Calendar
{"type":"self_check","course":string or null,"topic":string} they want to test themselves on one topic ("test me on stacks", "check my recursion")
{"type":"proficiency","course":string or null} they ask how they're doing, their scores, or their weakest topics
{"type":"help"} they ask what you can do, how @me works, or for help or commands
{"type":"practice","id":string or null,"name":string or null,"topics":[string],"count":5|10|15,"source":"notes"|"topics"|null} they want practice problems, a review, or to be quizzed for an exam or quiz (opens a practice setup; use the exam's id if you can tell which one; source notes if they mention their notes or slides)
{"type":"add_materials","course":string or null} they want to add slides, notes, a study guide, or an old exam so quizzes match the class (opens the upload card)
{"type":"topic_importance","course":string,"topic":string,"important":boolean} they say a lecture topic isn't important or doesn't need prep (important false), or that it matters again (important true). Use the exact topic name from the data
{"type":"undo"} undo the last change (use alone)
Rules: protect sleep; never schedule past the cutoff. Use exact ids from the data. Resolve relative dates like "next Tuesday" from today. If they ask why a session is when it is, explain using preferences, free time, deadlines, sleep cutoff, and grade weight.
Reply: 1 to 3 short sentences, warm and casual, saying what you did. If you use make_plan or replan, keep the reply very short.`;
  const ctx = JSON.stringify({
    user_message: text, courses: S.courses.map(c => c.code + (c.name ? ' ' + c.name : '')),
    weekly_schedule: S.routine.map(r => `${r.title}: ${daysTxt(r.days)} ${fmt(r.s)} to ${fmt(r.e)}`), one_offs: S.oneoff.map(o => `${o.title} ${o.date} ${fmt(o.s)}`),
    items: liveItems().filter(i => i.date >= addDays(T, -7)).slice(0, 40).map(i => ({ id: i.id, course: i.course, name: i.name, type: i.type, date: i.date, time: i.time != null ? fmt(i.time) : null, weight: i.weight, topics: i.topics })),
    planned_sessions: S.plan.filter(b => b.status === 'planned').slice(0, 40).map(b => ({ id: b.id, title: b.title, date: b.date, start: fmt(b.s), end: fmt(b.e), itemId: b.itemId })),
    upcoming_lectures: S.courses.flatMap(c => (c.lectures || []).filter(l => l.date >= addDays(T, -7)).slice(0, 10).map(l => `${c.code} ${l.date}: ${l.topic}`)),
    no_class_days: S.courses.flatMap(c => (c.noClass || []).filter(d => d >= T).map(d => `${c.code} ${d}`)),
    not_important_topics: S.skipTopics || {},
    class_study_levels: Object.fromEntries(S.courses.map(c => [c.code, c.priority || 'normal'])),
    no_prep_items: liveItems().filter(i => i.noPrep).map(i => i.id),
    course_materials: (S.materials || []).map(m => `${m.course}: ${m.name} (${KINDS[m.kind]})`),
    preferences: S.prefs, settings: { ...S.extras, bedtime: fmt(S.extras.bedtime) }, readiness: S.ready, remembered: S.memory.slice(-15).map(m => m.t)
  });
  let out = null;
  if (UI.aiOk) { try { out = await aiJSON(sys, ctx); if (typeof out.reply !== 'string' || !Array.isArray(out.actions)) out = null; } catch (e) { out = null; } }
  setAI(out ? 'live' : 'fallback'); if (!out) out = fallbackIntent(text);
  th.remove();
  const planning = out.actions.some(a => a.type === 'make_plan' || a.type === 'replan');
  if (out.reply && !planning) msg('bot', esc(out.reply));
  let changed = false;
  for (const a of out.actions.slice(0, 6)) { const r = await exec(a); if (r === true) changed = true; else if (typeof r === 'string') msg('bot', esc(r)); }
  if (planning && out.reply && !S.plan.length) msg('bot', esc(out.reply));
  if (UI.undoAfter) { UI.undoAfter = false; if (snapshot() === snap && UI.hist.length) return undoTo(UI.hist.length - 1, true); }
  commitUndo(snap, text.length > 28 ? text.slice(0, 27) + '…' : text);
  if (changed && !planning) refreshNext();
}
async function send() {
  const t = $('input').value.trim(); if (!t || UI.busy) return; $('input').value = ''; closeSlash(); msg('user', esc(t));
  if (t.startsWith('/')) { await runSlash(t); return; }
  UI.busy = true; $('send').disabled = true; try { await chat(t); } finally { UI.busy = false; $('send').disabled = false; }
}

/* ---------- /help and slash commands ---------- */
// Shortcuts that run right away, no AI needed.
const COMMANDS = [
  { cmd: 'help', desc: 'See everything @me can do', run: () => showHelp() },
  { cmd: 'plan', desc: 'Plan (or re-plan) your study sessions', run: async () => { await exec({ type: 'make_plan' }); } },
  { cmd: 'practice', args: '[exam or topic]', desc: 'Practice problems for an exam, like /practice midterm', run: async arg => { const it = practiceTarget({ name: arg }); practiceCard(it, { topics: it ? courseTopics(it.course).filter(t => arg && arg.toLowerCase().includes(t.toLowerCase())) : [] }); } },
  { cmd: 'check', args: '[topic]', desc: 'A 5-question self-check on one topic, like /check recursion', run: async arg => { const f = findTopic(arg) || (() => { const r = profRows(UI.profCourse || S.courses[0]?.code || ''); const x = r.filter(z => z.p?.pct != null).sort((p, q) => p.p.pct - q.p.pct)[0] || r[0]; return x && { code: UI.profCourse || S.courses[0].code, t: x.t }; })(); if (!f) { msg('bot', 'Add a class with lecture topics first, then I can check how you\'re doing on each one.'); return; } await selfCheck(f.code, f.t); } },
  { cmd: 'briefing', args: '[today or tomorrow]', desc: 'Your day at a glance', run: async arg => showBriefing(/tomorrow/i.test(arg) ? nextWeekday(addDays(today(), 1)) : /today/i.test(arg) && isWeekday(today()) ? today() : undefined) },
  { cmd: 'surprise', desc: 'Add a surprise quiz and get quick prep', run: () => openSurprise() },
  { cmd: 'add', desc: 'Add a class from a syllabus or Canvas', run: () => addClassCard(!S.courses.length) },
  { cmd: 'syllabus', desc: 'Import a syllabus (PDF, Word, or pasted text)', run: () => sylCard() },
  { cmd: 'schedule', desc: 'Add class times from your schedule', run: () => scheduleCard() },
  { cmd: 'notes', args: '[class]', desc: 'Add slides, notes, or an old exam', run: arg => materialsCard(S.courses.find(c => arg && arg.toLowerCase().includes(c.code.toLowerCase()))?.code) },
  { cmd: 'google', desc: 'Connect Google Calendar, or add classes and deadlines to it', run: async () => { if (!UI.google) await connectGoogle(); else await offerGoogleExtras(true); } },
  { cmd: 'undo', desc: 'Undo the last change', run: async () => { if (UI.hist.length) await undoTo(UI.hist.length - 1, true); else msg('bot', 'There\'s nothing to undo yet.'); } },
  { cmd: 'settings', desc: 'Open Settings (AI key, Canvas, demo mode)', run: () => { chrome.runtime.openOptionsPage(); msg('bot', 'Opened Settings in a new tab.'); } }
];
async function runSlash(text) {
  const [, name = '', arg = ''] = text.match(/^\/(\S*)\s*(.*)$/) || [];
  const c = COMMANDS.find(x => x.cmd === name.toLowerCase()) || COMMANDS.find(x => name && x.cmd.startsWith(name.toLowerCase()));
  if (!c) { msg('bot', esc(`I don't know /${name}. Type /help to see what I can do.`)); return; }
  UI.busy = true; $('send').disabled = true;
  try { await c.run(arg.trim()); } finally { UI.busy = false; $('send').disabled = false; }
}
// What to try next, based on where the student is.
function nextSteps() {
  const T = today(), s = [];
  if (!UI.aiOk) s.push(['Add an AI key in Settings so I can read PDFs and write better quizzes. Gemini has a free tier.', '/settings']);
  if (!S.courses.length) s.push(['Start by adding a class.', '/add']);
  else {
    if (S.courses.some(c => !S.routine.some(r => r.course === c.code))) s.push(['Some classes have no meeting times yet.', '/schedule']);
    if (!UI.google) s.push(['Connect Google Calendar so I plan around your real week.', '/google']);
    if (S.prefs && !S.plan.some(b => b.status === 'planned')) s.push(['You don\'t have a study plan yet.', '/plan']);
    const ex = liveItems().filter(i => i.type === 'exam' && i.date >= T).sort((x, y) => x.date.localeCompare(y.date))[0];
    if (ex && dayDiff(T, ex.date) <= 14) s.push([`${ex.course} ${shortName(ex)} is ${relDay(ex.date) === 'today' ? 'today' : `in ${dayDiff(T, ex.date)} days`}. Practice for it.`, '/practice ' + shortName(ex).toLowerCase()]);
    if (!(S.materials || []).length) s.push(['Add your lecture slides so quizzes match your class.', '/notes']);
  }
  return s.slice(0, 3);
}
function showHelp() {
  toggle(true);
  const ex = (t, cls = '') => `<button class="chip try${cls}" data-try="${esc(t)}">${esc(t)}</button>`;
  const steps = nextSteps();
  const c1 = S.courses[0]?.code || 'CS 0445', c2 = S.courses.at(-1)?.code || 'COMMRC 0520';
  const ex1 = liveItems().filter(i => i.type === 'exam' && i.date >= today()).sort((x, y) => x.date.localeCompare(y.date))[0];
  const tps = ex1 ? P.keepTopics(ex1.course, ex1.topics || []).filter(t => t !== 'Everything') : [];
  const topicA = (tps[0] || 'recursion'), topicB = tps[1] || tps[0] || 'Java Review';
  const examWord = ex1 ? (/final/i.test(ex1.name) ? 'final' : /midterm/i.test(ex1.name) ? 'midterm' : 'exam') : 'midterm';
  const c = card(`<h3>What I can do</h3>
    <p class="muted" style="margin:0">Just talk to me normally. Tap any example to try it.</p>
    ${steps.length ? `<div class="hsec"><h4>Right now</h4>${steps.map(([t, cmd]) => `<div class="hstep"><span>${esc(t)}</span>${ex(cmd)}</div>`).join('')}</div>` : ''}
    <div class="hsec"><h4>📅 Plan your week</h4><div class="chips">${['plan my week', 'I work Tue and Thu 2-6pm', 'I want to study on weekends', 'keep prep closer to deadlines'].map(t => ex(t)).join('')}</div></div>
    <div class="hsec"><h4>📚 Your classes</h4><div class="chips">${['import my syllabus', `${c1} meets Tue 6-8:30pm`, 'add my lecture slides', 'add my classes to Google Calendar'].map(t => ex(t)).join('')}</div></div>
    <div class="hsec"><h4>✏️ Study and practice</h4><div class="chips">${[`review for my ${examWord}`, `quiz me on ${topicA.toLowerCase()}`, `test me on ${topicA.toLowerCase()}`, 'how am I doing?', 'what\'s covered in lecture this week?', `${topicB} isn\'t important`].map(t => ex(t)).join('')}</div></div>
    <div class="hsec"><h4>🔁 When plans change</h4><div class="chips">${['my quiz got cancelled', `there\'s a pop quiz in ${c1} tomorrow`, `I don\'t need to study for ${c2}`, 'undo that'].map(t => ex(t)).join('')}</div></div>
    <div class="hsec"><h4>☀️ Your day</h4><div class="chips">${['what does tomorrow look like?', 'what\'s due this week?'].map(t => ex(t)).join('')}</div></div>
    <div class="hsec"><h4>⌨️ Shortcuts</h4><p class="muted small" style="margin:0 0 6px">Type / in the message box to see these anytime.</p>
      <ul class="cmds">${COMMANDS.map(x => `<li><button class="cmdname" data-try="/${x.cmd}">/${x.cmd}</button>${x.args ? ` <span class="muted small">${esc(x.args)}</span>` : ''}<span class="cdesc">${esc(x.desc)}</span></li>`).join('')}</ul></div>
    <div class="hsec"><h4>💡 Good to know</h4><ul class="tips">
      <li>Tap any block on the calendar to see why it's there, or its × to skip, move, or remove it.</li>
      <li>A red ❗ means I changed your calendar on my own. Tap it to review.</li>
      <li>The 📊 Proficiency bars above the calendar come only from scored questions, so they show what you actually know.</li>
      <li>Everything can be undone with the Undo button, Ctrl+Z, or "undo that."</li>
      <li>Your data stays in Chrome on this computer.</li></ul></div>`);
  c.classList.add('helpcard');
  // Long card: start at its top instead of the bottom.
  requestAnimationFrame(() => { $('stream').scrollTop = Math.max(0, c.offsetTop - $('stream').offsetTop - 12); });
  c.addEventListener('click', e => {
    const b = e.target.closest('[data-try]'); if (!b || UI.busy) return;
    $('input').value = b.dataset.try; send();
  });
}
// The / menu above the message box.
let slashIdx = 0;
function slashItems() {
  const v = $('input').value;
  if (!v.startsWith('/') || /\s/.test(v)) return [];
  const q = v.slice(1).toLowerCase();
  return COMMANDS.filter(c => c.cmd.startsWith(q));
}
function renderSlash() {
  const items = slashItems(), m = $('slashMenu');
  if (!items.length) { closeSlash(); return; }
  slashIdx = Math.min(slashIdx, items.length - 1);
  m.innerHTML = items.map((c, i) => `<div class="sitem${i === slashIdx ? ' on' : ''}" role="option" aria-selected="${i === slashIdx}" data-cmd="${c.cmd}"><b>/${c.cmd}</b>${c.args ? ` <span class="muted small">${esc(c.args)}</span>` : ''}<span>${esc(c.desc)}</span></div>`).join('');
  m.hidden = false;
}
function closeSlash() { $('slashMenu').hidden = true; slashIdx = 0; }
function pickSlash(cmd) {
  const c = COMMANDS.find(x => x.cmd === cmd); if (!c) return;
  if (c.args) { $('input').value = `/${c.cmd} `; closeSlash(); $('input').focus(); }
  else { $('input').value = `/${c.cmd}`; send(); }
}
$('input').addEventListener('input', () => { slashIdx = 0; renderSlash(); });
$('slashMenu').addEventListener('mousedown', e => { const it = e.target.closest('.sitem'); if (it) { e.preventDefault(); pickSlash(it.dataset.cmd); } });
$('helpBtn').onclick = () => { if (!UI.busy) { msg('user', '/help'); showHelp(); } };

/* ---------- startup ---------- */
$('send').onclick = send;
$('input').addEventListener('keydown', e => {
  const items = $('slashMenu').hidden ? [] : slashItems();
  if (items.length) {
    if (e.key === 'ArrowDown') { e.preventDefault(); slashIdx = (slashIdx + 1) % items.length; renderSlash(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); slashIdx = (slashIdx - 1 + items.length) % items.length; renderSlash(); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && $('input').value.trim() !== `/${items[slashIdx].cmd}`)) { e.preventDefault(); pickSlash(items[slashIdx].cmd); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSlash(); return; }
  }
  if (e.key === 'Enter') send();
});
// Pasting a whole syllabus or schedule into the one-line chat box would squash it, so catch it and offer to import it.
$('input').addEventListener('paste', e => {
  const t = (e.clipboardData || window.clipboardData)?.getData('text') || '';
  if (t.length < 300 || t.split('\n').length < 4 || UI.busy) return;
  e.preventDefault(); toggle(true);
  const lines = t.split('\n').length, looksLikeSchedule = t.length < 1500 && !/syllabus|grading|exam|midterm|due/i.test(t);
  msg('user', esc(`(pasted ${lines} lines)`));
  msg('bot', 'Looks like you pasted a whole document. Want me to import it?');
  const c = card(`<div class="btns" style="margin:0"><button class="btn${looksLikeSchedule ? ' ghost' : ''}" data-a="syl">📄 It's a syllabus</button><button class="btn${looksLikeSchedule ? '' : ' ghost'}" data-a="sched">📋 It's my class schedule</button><button class="btn ghost" data-a="no">Neither</button></div>`);
  c.addEventListener('click', ev => {
    const a = ev.target.closest('button')?.dataset.a; if (!a || ev.target.disabled) return; lock(c);
    if (a === 'syl') sylCard(t); else if (a === 'sched') scheduleCard(t); else { $('input').value = t.replace(/\s+/g, ' ').slice(0, 500); $('input').focus(); }
  });
});
$('launch').onclick = () => toggle(!$('chat').classList.contains('open'));
$('nudge').onclick = () => toggle(true); $('close').onclick = () => toggle(false);
$('addClass').onclick = () => { const was = started; toggle(true); if (was && !UI.busy) addClassCard(!S.courses.length); };
$('prevW').onclick = () => { UI.week = addDays(UI.week, -7); buildCal(); };
$('nextW').onclick = () => { UI.week = addDays(UI.week, 7); buildCal(); };
$('thisW').onclick = () => { UI.week = mondayOf(isWeekday(today()) ? today() : nextWeekday(today())); buildCal(); };
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) { e.preventDefault(); if (UI.hist.length) undoTo(UI.hist.length - 1); return; }
  if (e.key !== 'Escape') return;
  if (!$('slashMenu').hidden) { closeSlash(); return; }
  if ($('sqModal').classList.contains('on')) { closeSurprise(); return; }
  if ($('ctModal').classList.contains('on')) { closeClassTimes(); return; }
  if (document.querySelector('.pop')) { document.querySelector('.pop').remove(); return; }
  if ($('chat').classList.contains('open')) toggle(false);
});

// The background worker writes to storage when it finds new Canvas items. Pull those changes in.
chrome.runtime.onMessage.addListener(async m => {
  if (m?.type !== 'state-changed' || m.from === 'app') return;
  if (UI.busy || UI.inSession) return;
  const fresh = await loadState();
  const hadAlerts = S.alerts.length;
  Object.assign(S, fresh); renderAll();
  if (S.alerts.length > hadAlerts) { $('launch').classList.add('alert'); UI.reviewShown = false; if ($('chat').classList.contains('open')) reviewCard(); else showAlertNudge(S.alerts.at(-1).summary); }
});
// Settings changes (new API key, Google, Canvas) update the status chips right away.
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch['atme:settings']) checkConnections(); });
// Keep the "now" line and today's free time current.
setInterval(() => { if (!UI.inSession) { buildCal(); missedCard(); } }, 5 * 60e3);

await checkConnections();
if (S.step) setStep(S.step); else setStep(0);
if (S.courses.length && S.courses.some(c => !S.routine.some(x => x.course === c.code)) && !S.askedTimes) { S.askedTimes = true; setTimeout(() => { toggle(true); askForMissingTimes(); }, 900); }
if (UI.google) { refreshBusy(true, true).then(ok => { if (ok) renderAll(); }); }
else if (S.gcal.calendarId) { setTimeout(() => { toggle(true); msg('bot', 'Google Calendar needs you to reconnect, since @me can now read your event names and add your class schedule. Click "Connect Google" in the top bar.'); }, 600); }
setInterval(() => { if (UI.google && !UI.busy && !UI.inSession && document.visibilityState === 'visible') refreshBusy(true, true).then(ok => ok && renderAll()); }, 2 * 60e3);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && UI.google && !UI.busy && !UI.inSession && Date.now() - (S.gbusyAt || 0) > 30e3) refreshBusy(true, true).then(ok => ok && renderAll()); });
renderAll(); renderUndo();
const params = new URLSearchParams(location.search);
setTimeout(() => missedCard(), 1500);
if (S.active) {
  const b = S.plan.find(x => x.id === S.active.id);
  toggle(true);
  if (b) { msg('bot', S.active.end > Date.now() ? 'Welcome back! Your session is still running ⏱️' : 'Your session finished while you were away. Nice work!'); runTimer(b); }
  else S.active = null;
} else if (params.get('review') || S.alerts.length) {
  if (params.get('review')) toggle(true); else showAlertNudge(S.alerts.at(-1).summary);
} else if (params.get('brief')) { toggle(true); showBriefing(); }
else if (params.get('surprise')) { openSurprise(); }
else if (params.get('chat') || !S.courses.length) { if (S.courses.length) toggle(true); }
if (params.toString()) history.replaceState(null, '', location.pathname);

// Lets boot.js know startup finished. If @me keeps running for 15 seconds, this start counts as healthy.
window.__atmeReady = true;
setTimeout(() => { if (!SAFE) localStorage.setItem(BOOT_KEY, '0'); }, 15000);
if (SAFE) {
  const bar = document.createElement('div'); bar.className = 'safebar'; bar.setAttribute('role', 'status');
  bar.innerHTML = `<span><b>Safe mode.</b> @me didn't finish starting the last two times, so Google, Canvas, focus mode, and background checks are paused. Your plan is still here.</span><button id="safeOff">Turn safe mode off</button>`;
  document.body.prepend(bar);
  document.getElementById('safeOff').onclick = async () => { localStorage.setItem(BOOT_KEY, '0'); await chrome.storage.local.set({ 'atme:safe': false }); location.href = location.pathname; };
}
