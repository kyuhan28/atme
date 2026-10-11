import { loadSettings } from './store.js';
import { iso, today, addDays, WK, toHM } from './util.js';

export class CanvasError extends Error {}

export const cleanDomain = d => String(d || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
export const originFor = domain => `https://${cleanDomain(domain)}/*`;

// Chrome only lets the extension talk to the user's school Canvas after they approve that one site.
export async function hasPermission(domain) {
  if (!domain) return false;
  return chrome.permissions.contains({ origins: [originFor(domain)] });
}
export async function requestPermission(domain) {
  return chrome.permissions.request({ origins: [originFor(domain)] });
}

async function cfg() {
  const s = await loadSettings();
  const domain = cleanDomain(s.canvasDomain);
  if (!domain || !s.canvasToken) throw new CanvasError('Add your Canvas address and access token in @me Settings first.');
  if (!(await hasPermission(domain))) throw new CanvasError('@me needs permission to reach your Canvas. Open Settings and click "Connect Canvas".');
  return { base: `https://${domain}/api/v1`, token: s.canvasToken };
}

async function getAll(path) {
  const { base, token } = await cfg();
  let url = path.startsWith('http') ? path : base + path;
  const out = [];
  for (let page = 0; url && page < 20; page++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (res.status === 401) throw new CanvasError('Canvas rejected your access token. It may have expired, so make a new one in Canvas.');
    if (!res.ok) throw new CanvasError(`Canvas returned ${res.status} for ${path.split('?')[0]}`);
    const data = await res.json();
    if (Array.isArray(data)) out.push(...data); else return data;
    const link = res.headers.get('Link') || '';
    url = (link.match(/<([^>]+)>;\s*rel="next"/) || [])[1] || null;   // Canvas paginates with Link headers
  }
  return out;
}

export async function testConnection() {
  const me = await getAll('/users/self/profile');
  return me?.name || 'Connected';
}

// Turns Canvas course codes into short labels: "CHEM 161", or for numeric codes like Rutgers'
// "01:160:161 GEN CHEM", the words plus the course number, "GEN CHEM 161".
const shortCode = c => {
  const src = `${c.course_code || ''} ${c.name || ''}`;
  const m = src.match(/\b([A-Z]{2,7})\s?-?(\d{3,4}[A-Z]?)\b/);
  if (m) return `${m[1]} ${m[2]}`;
  const num = (c.course_code || '').match(/(?:\d{1,3}:)*\d{2,3}:(\d{3}[A-Z]?)/);
  if (num) {
    const words = (c.course_code || '').replace(num[0], '').replace(/[^A-Za-z& ]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 2).join(' ').toUpperCase();
    const initials = (c.name || '').split(/\s+/).filter(w => /^[A-Za-z]{3,}/.test(w) && !/^(and|the|for|with|intro|introduction)$/i.test(w)).slice(0, 2).map(w => w.slice(0, 4).toUpperCase()).join(' ');
    return `${words || initials || 'COURSE'} ${num[1]}`.slice(0, 16).trim();
  }
  return (c.course_code || c.name || 'Course').slice(0, 16).trim();
};
function classify(name, isQuiz) {
  if (/\b(midterm|final|exam|test)\b/i.test(name)) return 'exam';
  if (isQuiz || /\bquiz\b/i.test(name)) return 'quiz';
  return 'assignment';
}
function localParts(isoStr) {
  const d = new Date(isoStr);
  let h = d.getHours() + d.getMinutes() / 60;
  return { date: iso(d), time: h >= 23.9 ? null : Math.round(h * 100) / 100 };
}

const day = d => d ? iso(new Date(d)) : null;

// Some schools put class meetings on the Canvas calendar. If the same time slot repeats week after week,
// treat it as a class meeting.
function inferMeetings(events) {
  const slots = {};
  for (const ev of events) {
    if (!ev.start_at || !ev.end_at || /\b(exam|midterm|final|quiz|test|due)\b/i.test(ev.title || '')) continue;
    const st = new Date(ev.start_at), en = new Date(ev.end_at), dur = (en - st) / 36e5;
    if (dur <= 0.3 || dur > 4 || st.toDateString() !== en.toDateString()) continue;
    const sh = st.getHours() + st.getMinutes() / 60, eh = en.getHours() + en.getMinutes() / 60, d = WK[st.getDay()];
    const k = `${d}|${sh}|${eh}`;
    (slots[k] = slots[k] || { d, sh, eh, n: 0, titles: '' }).n++; slots[k].titles += ' ' + (ev.title || '');
  }
  const byTime = {};
  for (const g of Object.values(slots).filter(g => g.n >= 2)) {
    const k = `${g.sh}|${g.eh}`; (byTime[k] = byTime[k] || { days: [], sh: g.sh, eh: g.eh, titles: '' });
    byTime[k].days.push(g.d); byTime[k].titles += g.titles;
  }
  const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  return Object.values(byTime).map(m => ({
    days: m.days.sort((a, b) => order.indexOf(a) - order.indexOf(b)), start: toHM(m.sh), end: toHM(m.eh),
    label: /\blab\b/i.test(m.titles) ? 'lab' : /recitation/i.test(m.titles) ? 'recitation' : /discussion/i.test(m.titles) ? 'discussion' : 'lecture'
  }));
}
const htmlToText = h => String(h || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

// Lists the student's Canvas courses and marks which ones belong to the current semester.
// Canvas keeps old courses "active" at many schools, so term dates are the real signal.
export async function listCourses() {
  const courses = await getAll('/courses?enrollment_state=active&include[]=term&per_page=100');
  const now = Date.now(), soon = now + 21 * 864e5;
  const rows = courses.filter(c => c && c.id && !c.access_restricted_by_date && c.workflow_state !== 'deleted').map(c => {
    const t = c.term || {};
    const start = c.start_at || t.start_at || null, end = c.end_at || t.end_at || null;
    const dated = !!(start || end);
    const current = dated ? (!start || new Date(start).getTime() <= soon) && (!end || new Date(end).getTime() >= now) : null;
    return { id: c.id, code: shortCode(c), name: c.name || c.course_code || 'Course', term: t.name || '', start: day(start), end: day(end), dated, current };
  });
  // Courses with no dates (often "Default Term" sandboxes or orientation) only count if nothing else is dated as current.
  const anyCurrent = rows.some(r => r.current);
  rows.forEach(r => { if (r.current === null) r.current = !anyCurrent; });
  return rows.sort((a, b) => (b.current - a.current) || String(b.start || '').localeCompare(String(a.start || '')));
}

// Imports the chosen courses. Only items due between today and the end of that course's term come in,
// so old semesters can't leak into this one.
export async function importCourses(rows) {
  const T = today(), results = [];
  for (const c of rows) {
    const until = c.end ? addDays(c.end, 7) : addDays(T, 150);
    let groups = [], meta = {};
    try { meta = await getAll(`/courses/${c.id}?include[]=syllabus_body`); } catch { meta = {}; }
    try { groups = await getAll(`/courses/${c.id}/assignment_groups?include[]=assignments&per_page=50`); } catch { groups = []; }
    const weighted = !!meta.apply_assignment_group_weights;
    const ptsIn = g => (g.assignments || []).reduce((x, y) => x + (y.points_possible || 0), 0);
    const totalPts = groups.reduce((a, g) => a + ptsIn(g), 0);
    const weightOf = a => {
      const g = groups.find(g => g.id === a.assignment_group_id), pts = a.points_possible || 0;
      if (!g || !pts) return null;
      if (weighted) { const gp = ptsIn(g); return gp ? g.group_weight * pts / gp : null; }
      return totalPts ? 100 * pts / totalPts : null;
    };
    const assignments = await getAll(`/courses/${c.id}/assignments?bucket=future&order_by=due_at&per_page=100`);
    const items = assignments.filter(a => a.due_at).map(a => {
      const p = localParts(a.due_at);
      return { canvasId: 'a' + a.id, name: a.name, type: classify(a.name, a.is_quiz_assignment || (a.submission_types || []).includes('online_quiz')),
        date: p.date, time: p.time, weight: weightOf(a), topics: [], assigned: a.unlock_at ? localParts(a.unlock_at).date : null };
    }).filter(i => i.date >= T && i.date <= until);
    let meetings = [];
    try {
      const events = await getAll(`/calendar_events?type=event&context_codes[]=course_${c.id}&start_date=${T}&end_date=${until}&per_page=100`);
      meetings = inferMeetings(events.filter(ev => ev.start_at && ev.start_at.slice(0, 10) <= addDays(T, 35)));
      for (const ev of events) {
        if (!ev.start_at || !/\b(exam|midterm|final|quiz|test)\b/i.test(ev.title || '')) continue;
        const p = localParts(ev.start_at), dur = ev.end_at ? (new Date(ev.end_at) - new Date(ev.start_at)) / 36e5 : null;
        if (p.date < T || p.date > until) continue;
        items.push({ canvasId: 'e' + ev.id, name: ev.title.slice(0, 60), type: classify(ev.title, false), date: p.date, time: p.time, dur: dur && dur < 5 ? dur : null, topics: [] });
      }
    } catch { /* calendar events are optional */ }
    const syllabusText = htmlToText(meta.syllabus_body).slice(0, 40000);
    results.push({ source: 'canvas', canvasId: c.id, course: { code: c.code, name: c.name }, meetings, items, syllabusText,
      term: { name: c.term, start: c.start, end: c.end } });
  }
  return results;
}

// Used by the background worker: re-reads the courses already imported from Canvas.
export async function refreshImported(canvasIds) {
  const rows = (await listCourses()).filter(r => canvasIds.includes(r.id));
  return importCourses(rows);
}
