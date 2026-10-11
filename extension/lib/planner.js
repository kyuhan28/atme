import { addDays, today, nowH, wkey, isWeekday, nextWeekday, dayDiff, parseHM, uid, WK, shortName } from './util.js';

export const START = 8;
export const DAILY_CAP = 150;
const PREFWIN = { Morning: [8, 12], Afternoon: [12, 17], Evening: [17, 24] };
const ANCHOR = { Morning: 9, Afternoon: 14, Evening: 19 };

// All scheduling logic, bound to one state object. Used by both the dashboard and the background worker.
// What each kind of session is for, so the student knows what to actually do.
export const STYPES = {
  coding:   { icon: '💻', label: 'Coding practice', how: 'Write and run small programs on these topics without your notes. Redo a past lab or a textbook problem, then compare.' },
  concepts: { icon: '🧠', label: 'Concept review', how: 'Skim your lecture notes, then close them and explain each idea out loud or on paper in your own words.' },
  problems: { icon: '✍️', label: 'Practice problems', how: 'Work practice problems without peeking at the solutions, then check every answer.' },
  pastexam: { icon: '⏱️', label: 'Practice exam', how: 'Time yourself on a past exam or practice questions under test conditions, then go over every miss.' },
  project:  { icon: '🛠️', label: 'Project work', how: 'Work through this milestone. Stop at a point where it runs or is saved.' },
  writing:  { icon: '📝', label: 'Writing', how: 'Work through this step of the writing.' },
  lab:      { icon: '🧪', label: 'Lab work', how: 'Read the lab handout, get it working, and test it before you submit.' },
  review:   { icon: '🔁', label: 'Quick review', how: '20 minutes: flashcards or one practice problem on this topic.' },
  group:    { icon: '👥', label: 'Group review', how: 'Quiz each other and explain answers out loud.' }
};
// Big assignments get milestone sessions from the day they're assigned, instead of a last-minute push.
const MILESTONES = {
  code: [['Read spec & plan', 'Read the whole spec, list every part you need to build, and set up the starter code.'],
         ['Build the core', 'Get the main logic working, even if it\'s rough. Save a copy once it runs.'],
         ['Keep building', 'Finish the remaining parts of the spec, one at a time.'],
         ['Test & debug', 'Test edge cases (empty input, one item, huge input) and fix what breaks.'],
         ['Polish & submit', 'Clean up, comment your code, re-read the spec, and submit early.']],
  writing: [['Outline', 'Pick your main argument and outline your points and sources.'],
            ['First draft', 'Write the whole thing quickly without editing.'],
            ['Keep drafting', 'Fill in the weakest sections of your draft.'],
            ['Revise', 'Fix the structure and arguments, and cut what doesn\'t help.'],
            ['Final pass', 'Proofread, check the formatting rules, and submit.']],
  speech: [['Outline', 'Pick your main points and build an outline.'],
           ['Notes & slides', 'Write your speaker notes and make any slides.'],
           ['Tighten it', 'Trim it to the time limit and smooth the transitions.'],
           ['Rehearse', 'Practice out loud twice and time yourself.'],
           ['Final run-through', 'One last timed run, then you\'re done.']]
};
const PICK = { 1: [4], 2: [0, 4], 3: [0, 1, 4], 4: [0, 1, 3, 4], 5: [0, 1, 2, 3, 4] };
const CS_CODE = /^(CS|CMPSC|COMPSCI|CSE|CSC|CMSC|COMS|COSC|CPSC|CSCI|INFSCI|SE)\b/i;
const CS_NAME = /program|computer|algorithm|data struct|software|coding|java|python|operating system|machine learning/i;

export function createPlanner(S) {
  const active = b => !['skipped', 'removed'].includes(b.status);
  const isCS = code => { const c = S.courses.find(x => x.code === code); return CS_CODE.test(code || '') || CS_NAME.test(c?.name || '') || (c?.lectures || []).some(l => /java|python|recursion|linked|algorithm/i.test(l.topic)); };
  const isProject = t => t?.type === 'assignment' && (/(project|paper|essay|report|presentation|speech|portfolio|capstone)/i.test(t.name) || (t.weight || 0) >= 5);
  const workKind = t => /(speech|presentation)/i.test(t.name) ? 'speech' : /(paper|essay|report|reflection|outline)/i.test(t.name) ? 'writing' : 'code';
  // Weekends only count if the student turned them on, and they start later.
  const isStudyDay = d => isWeekday(d) || (S.extras.weekends === 'both') || (S.extras.weekends === wkey(d));
  const capFor = d => isWeekday(d) ? DAILY_CAP : 120;
  const late = () => S.extras.rhythm === 'late';
  function stypeOf(b) {
    if (b.stype) return b.stype;
    const it = itemById(b.itemId);
    if (b.kind === 'review') return 'review';
    if (b.kind === 'group') return 'group';
    if (it?.type === 'assignment') return isProject(it) ? (workKind(it) === 'code' ? 'project' : 'writing') : 'lab';
    if ((b.topics || []).includes('Everything') || /practice exam/i.test(b.title)) return 'pastexam';
    return b.kind === 'extra' ? (isCS(b.course) ? 'coding' : 'problems') : 'concepts';
  }
  const liveItems = () => S.items.filter(i => i.status !== 'cancelled');
  const itemById = id => S.items.find(i => i.id === id);
  const examLen = x => x.dur || 1.33;
  const lectureLike = r => !/lab|recitation|discussion/i.test(r.title || '');
  // An exam held during a class meeting takes over that whole meeting: the class doesn't show alongside it,
  // and the rest of the class period never counts as free time. An exam with no time listed, on a day the
  // class meets, takes the lecture's slot. Returns null for an exam with no time on a day with no class.
  const isFinal = x => x?.type === 'exam' && /\bfinal\b/i.test(x.name || '');
  function examSpan(x) {
    // Finals usually follow the school's finals schedule, not the lecture time: own time, about 2 hours.
    if (isFinal(x)) return x.time == null ? null : { s: x.time, e: Math.min(24, x.time + (x.dur || 2)), meeting: null };
    const meets = S.routine.filter(r => r.course === x.course && r.days.includes(wkey(x.date)) && !(r.skip || []).includes(x.date));
    if (x.time == null) {
      const m = meets.find(lectureLike) || meets[0];
      return m ? { s: m.s, e: m.e, meeting: m.id } : null;
    }
    let s = x.time, e = x.time + examLen(x);
    const hit = meets.filter(r => s < r.e && e > r.s).sort((a, b) => lectureLike(b) - lectureLike(a))[0];
    if (hit) { s = Math.min(s, hit.s); e = x.dur ? Math.max(e, hit.e) : hit.e; }
    return { s, e, meeting: hit?.id || null };
  }
  const nextExam = () => liveItems().filter(i => i.type === 'exam' && i.date >= today()).sort((a, b) => a.date.localeCompare(b.date))[0];

  function eventsOn(date) {
    const k = wkey(date), ev = [];
    const exams = liveItems().filter(i => i.date === date && i.type === 'exam').map(x => ({ x, sp: examSpan(x) })).filter(o => o.sp);
    const finals = liveItems().filter(i => i.date === date && isFinal(i)).map(i => i.course);
    S.routine.filter(r => r.days.includes(k)).forEach(r => {
      if (finals.includes(r.course)) return;   // no lecture or recitation on the day of that class's final
      if (exams.some(({ x, sp }) => x.course === r.course && sp.s < r.e && sp.e > r.s)) return;   // the exam replaces this class
      if ((r.skip || []).includes(date)) return;                    // skipped just this once
      const c = r.course && S.courses.find(x => x.code === r.course);
      if (c && ((c.noClass || []).includes(date) || (S.holidays || []).includes(date))) return;   // no class that day
      const side = /lab|recitation|discussion/i.test(r.title);
      const topic = c && !side ? lectureOn(c, date)?.topic : null;
      const recap = c && side ? lectureBefore(c, date)?.topic : null;
      ev.push({ s: r.s, e: r.e, title: topic ? `${r.title}: ${topic}` : r.title, base: r.title, kind: r.course ? 'class' : 'busy', topic, recap, rid: r.id });
    });
    S.oneoff.filter(o => o.date === date).forEach(o => ev.push({ s: o.s, e: o.e, title: o.title, kind: 'busy', oid: o.id }));
    const ign = S.ignoredG || [];
    if (S.gevents) (S.gevents[date] || []).filter(x => !x.allDay && !x.free && !ign.includes(x.id) && !ign.includes('title:' + x.title)).forEach(x => ev.push({ s: x.s, e: x.e, title: x.title, kind: 'gcal', gid: x.id }));
    else (S.gbusy[date] || []).forEach(([s, e]) => ev.push({ s, e, title: 'Busy (Google Calendar)', kind: 'gbusy' }));
    exams.forEach(({ x, sp }) => ev.push({ s: sp.s, e: sp.e, title: `${x.course} ${x.name}`, kind: 'exam', itemId: x.id }));
    return ev.sort((a, b) => a.s - b.s);
  }
  // Topics the student marked "not important" get no prep, quizzes, or reviews.
  const isSkipped = (course, topic) => !!(S.skipTopics?.[course] || []).includes(topic);
  const keepTopics = (course, list) => (list || []).filter(t => !isSkipped(course, t));
  // How much prep something gets: a whole class can be Normal, Light, or None, and any single item can be "no prep".
  const levelOf = code => S.courses.find(c => c.code === code)?.priority || 'normal';
  const needsPrep = t => !!t && !t.noPrep && levelOf(t.course) !== 'none';
  const lectureOn = (c, date) => (c.lectures || []).find(l => l.date === date);
  const lectureBefore = (c, date) => [...(c.lectures || [])].reverse().find(l => l.date <= date);
  // What a study session is reviewing: its topics, or for a lab or project, the lecture it builds on.
  function coverage(b) {
    const it = itemById(b.itemId), c = S.courses.find(x => x.code === (it?.course || b.course));
    const generic = ['Everything', 'Lecture notes', 'Practice problems', 'Key concepts'];
    const real = keepTopics(it?.course || b.course, (b.topics || []).filter(t => !generic.includes(t)));
    const dated = t => { const l = (c?.lectures || []).find(x => x.topic === t); return l ? `${t} (lecture ${l.date.slice(5).replace('-', '/')})` : t; };
    const goal = it && it.type !== 'assignment' ? ` → ${shortName(it)}` : '';
    if (real.length) return { icon: '📖', text: real.join(', ') + goal, detail: real.map(dated).join('\n') + (goal ? `\n\nPrep for ${it.name} on ${it.date.slice(5).replace('-', '/')}` : '') };
    if (it?.type === 'assignment') { const l = c && lectureBefore(c, addDays(it.date, -1)); return { icon: '📝', text: `${it.name}${l ? ` · ${l.topic}` : ''}`, detail: l ? `${it.name}, based on the ${l.date.slice(5).replace('-', '/')} lecture: ${l.topic}` : it.name }; }
    const kept = it ? keepTopics(it.course, it.topics) : [];
    if (it && (b.topics || []).includes('Everything') && kept.length) return { icon: '📖', text: `All ${kept.length} topics${goal}`, detail: kept.map(dated).join('\n') };
    return null;
  }
  const examNextDay = date => liveItems().some(i => i.type === 'exam' && i.date === addDays(date, 1));
  const cutoff = date => S.extras.bedtime - (examNextDay(date) ? 1 : 0);

  function gaps(date, ignoreId) {
    const T = today();
    if (!isStudyDay(date) || date < T) return [];
    let start = isWeekday(date) ? START : 10;
    if (date === T) start = Math.max(start, Math.ceil((nowH() + 0.25) * 4) / 4);
    const end = cutoff(date);
    const busy = [...eventsOn(date).map(e => [e.s - 0.17, e.e + 0.17]),
      ...S.plan.filter(b => active(b) && b.date === date && b.id !== ignoreId).map(b => [b.s - 0.09, b.e + 0.09])].sort((a, b) => a[0] - b[0]);
    const out = []; let cur = start;
    for (const [a, b] of busy) { if (a > cur) out.push([cur, Math.min(a, end)]); cur = Math.max(cur, b); if (cur >= end) break; }
    if (cur < end) out.push([cur, end]);
    return out.filter(([a, b]) => b - a > 0.2);
  }

  function findSlot(date, lenMin, ignoreId, maxEnd) {
    const len = lenMin / 60, pref = S.prefs?.time || 'Evening', [pa, pb] = PREFWIN[pref];
    let best = null;
    for (let [a, b] of gaps(date, ignoreId)) {
      if (maxEnd != null) b = Math.min(b, maxEnd);
      if (b - a < len) continue;
      let s = Math.ceil(Math.max(ANCHOR[pref], a) * 4 - 1e-6) / 4;
      if (s + len > b + 1e-6) s = Math.floor((b - len) * 4 + 1e-6) / 4;
      if (s < a - 1e-6 || s + len > b + 1e-6) continue;
      const inPref = s >= pa && s + len <= pb + 1e-6;
      const score = (inPref ? 0 : 10) + Math.abs(s - ANCHOR[pref]) * 0.1;
      if (!best || score < best.score) best = { s, e: s + len, score, gap: [a, b], inPref };
    }
    return best;
  }
  const fits = (b, s, e) => gaps(b.date, b.id).some(([a, z]) => a <= s + 1e-6 && z >= e - 1e-6);
  const minsOf = b => Math.round((b.e - b.s) * 60);
  const studyMinsOn = date => S.plan.filter(b => active(b) && b.date === date).reduce((a, b) => a + minsOf(b), 0);
  function weekdaysBetween(a, b) {
    const out = [], ok = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
    if (!ok(a) || !ok(b)) return out;
    let d = a;
    for (let i = 0; d <= b && i < 400; i++) { if (isStudyDay(d)) out.push(d); d = addDays(d, 1); }
    return out;
  }

  function sessionsFor(t) {
    const w = S.extras.grades ? t.weight : null;
    if (t.type === 'exam') return w == null ? 4 : w >= 20 ? 5 : w >= 10 ? 4 : 3;
    if (t.type === 'quiz') return w != null && w >= 10 ? 3 : 2;
    return w != null && w >= 10 ? 2 : 1;
  }
  const lastDayFor = t => (t.type === 'assignment' && (t.time == null || t.time >= 18)) ? t.date : addDays(t.date, -1);
  function spread(days, n) {
    if (n >= days.length) return [...days];
    if (n === 1) return [days[days.length - 1]];
    const out = new Set(); for (let i = 0; i < n; i++) out.add(days[Math.round(i * (days.length - 1) / (n - 1))]);
    return [...out];
  }
  const blockFor = (t, date, slot, title, topics, kind, focus) =>
    ({ id: uid('b'), itemId: t.id, course: t.course, date, s: slot.s, e: slot.e, title: String(title).slice(0, 40), topics, kind, focus, status: 'planned' });

  function placeOne(preferred, window, len, used) {
    const order = [preferred, ...window.filter(d => d !== preferred).sort((a, b) => Math.abs(dayDiff(preferred, a)) - Math.abs(dayDiff(preferred, b)))];
    for (const pass of [0, 1]) for (const d of order) {
      if (pass === 0 && used.has(d)) continue;
      if (studyMinsOn(d) + len > capFor(d)) continue;
      const slot = findSlot(d, len); if (slot) return { d, slot };
    }
    return null;
  }

  function sessionPlans(t, n) {
    const T = t.topics?.length && !t.topics.includes('Everything') ? keepTopics(t.course, t.topics) : [];
    const plans = [];
    for (let i = 0; i < n; i++) {
      let title, topics, kind = 'study', focus;
      if (t.type === 'exam') {
        if (i === n - 1 && n > 1) { title = `${t.course} practice exam`; topics = T.length ? T : ['Everything']; focus = `Timed practice for ${t.name}, then review what you missed`; }
        else if (T.length > n - 1 && n > 1) {
          // More topics than sessions: give each session a slice of the topics, in course order.
          // Split evenly so no session ends up empty: 4 topics over 3 sessions is 1, 2, 1.
          const k = n - 1, chunk = T.slice(Math.round(i * T.length / k), Math.round((i + 1) * T.length / k));
          const tp = chunk.length ? chunk : [T[i % T.length]];
          title = `${t.course}: ${tp[0]}${tp.length > 1 ? ` +${tp.length - 1}` : ''}`; topics = tp; focus = `Review ${tp.join(', ')} for ${shortName(t)}`;
        }
        else { const tp = T.length ? T[i % T.length] : i % 2 ? 'Practice problems' : 'Lecture notes'; title = `${t.course}: ${tp}`; topics = [tp]; focus = T.length ? `Review ${tp} for ${shortName(t)}` : `${tp} for ${shortName(t)}`; }
        if (S.prefs.group && n >= 3 && i === n - 2) { kind = 'group'; title = `${t.course} group review`; topics = T.length ? T : ['Everything']; focus = 'Quiz each other and compare notes'; }
      } else if (t.type === 'quiz') {
        const tp = T[0] || 'Key concepts';
        if (i === 0) { title = `${t.course}: ${tp}`; topics = [tp]; focus = `Review ${tp} before ${shortName(t)}`; }
        else { title = `${t.course} quiz prep`; topics = [tp]; focus = `Practice problems for ${shortName(t)}`; }
      } else if (isProject(t)) {
        const steps = MILESTONES[workKind(t)], [label, how] = steps[(PICK[Math.min(n, 5)] || PICK[5])[i] ?? 4];
        title = `${t.course} ${shortName(t)}: ${label}`; topics = T.slice(0, 1); focus = how;
      } else { title = `${t.course}: ${shortName(t)}`; topics = T.slice(0, 1); focus = `Work on ${t.name}${n > 1 ? ` (part ${i + 1} of ${n})` : ''}`; }
      // What kind of work this session is.
      let stype;
      if (kind === 'group') stype = 'group';
      else if (t.type === 'assignment') stype = isProject(t) ? (workKind(t) === 'code' ? 'project' : 'writing') : 'lab';
      else if (topics.includes('Everything') || (t.type === 'exam' && i === n - 1 && n > 1)) stype = 'pastexam';
      else stype = i % 2 === 0 ? 'concepts' : (isCS(t.course) ? 'coding' : 'problems');
      plans.push({ title, topics, kind, focus, stype });
    }
    return plans;
  }

  // Plans study time for everything due in the next 3 weeks that doesn't have sessions yet.
  function buildPlan(onlyIds, horizon = 21) {
    const T = today(), end = addDays(T, horizon), created = [], skipped = [], per = {};
    const rank = { exam: 0, quiz: 1, assignment: 2 };
    const targets = liveItems().filter(i => (!onlyIds || onlyIds.includes(i.id)) && i.date >= T && i.date <= end && !S.plan.some(b => b.status === 'planned' && b.itemId === i.id))
      .sort((a, b) => a.date.localeCompare(b.date) || rank[a.type] - rank[b.type] || (b.weight || 0) - (a.weight || 0));
    for (const t of targets) {
      const project = isProject(t);
      // Projects start when they're assigned (or two weeks out). Everything else looks back a set number of study days.
      const startDay = project ? [T, t.assigned || addDays(t.date, -14), late() ? addDays(t.date, -7) : T].sort().at(-1) : T;
      let window = weekdaysBetween(startDay, lastDayFor(t));
      if (!project) window = window.slice(-(late() ? (t.type === 'exam' ? 5 : t.type === 'quiz' ? 3 : 2) : (t.type === 'exam' ? 10 : t.type === 'quiz' ? 5 : 3)));
      if (!window.length) { skipped.push(t); continue; }
      if (!needsPrep(t)) { per[t.id] = { t, count: 0, missed: 0, unimportant: true }; continue; }
      let n = sessionsFor(t);
      let len = t.type === 'assignment' ? Math.min(90, Math.max(60, S.prefs.len)) : S.prefs.len;
      if (project) {
        const w = t.weight || 0;
        n = Math.max(1, Math.min(w >= 10 ? 5 : w >= 5 ? 4 : 3, Math.ceil(window.length / 2) || 1));
        len = Math.min(120, Math.max(90, S.prefs.len));
      }
      if (levelOf(t.course) === 'light') { n = Math.max(1, Math.ceil(n / 2)); len = Math.min(len, 45); }
      if (t.type !== 'assignment' && t.topics?.length && !t.topics.includes('Everything')) {
        const left = keepTopics(t.course, t.topics).length;
        if (!left) { per[t.id] = { t, count: 0, missed: 0, unimportant: true }; continue; }   // every topic is "not important"
        n = Math.min(n, left + (t.type === 'exam' ? 1 : 0));  // one session per topic, plus a practice exam
      }
      const days = late() && !project ? window.slice(-n) : spread(window, n), used = new Set(), placed = [];
      for (let i = 0; i < n; i++) {
        let r = placeOne(days[Math.min(i, days.length - 1)], window, len, used), short = false;
        // Tight week: try a shorter session before giving up on this one.
        const fallback = project ? 60 : 30;
        if (!r && len > fallback) { r = placeOne(days[Math.min(i, days.length - 1)], window, fallback, used); short = !!r; }
        if (!r) continue;
        used.add(r.d);
        const b = blockFor(t, r.d, r.slot, '', [], 'study', ''); if (short) b.short = true; S.plan.push(b); created.push(b); placed.push(b);
      }
      placed.sort((a, b) => a.date.localeCompare(b.date) || a.s - b.s);
      const ps = sessionPlans(t, n);
      while (ps.length > placed.length) { const j = ps.findIndex((p, ix) => ix < ps.length - 1 && p.kind === 'study'); ps.splice(j >= 0 ? j : 0, 1); }
      placed.forEach((b, j) => Object.assign(b, { title: ps[j].title.slice(0, 40), topics: ps[j].topics, kind: ps[j].kind, focus: ps[j].focus, stype: ps[j].stype, milestone: project || undefined }));
      per[t.id] = { t, count: placed.length, missed: n - placed.length };
    }
    created.sort((a, b) => (a.date + a.s).localeCompare(b.date + b.s));
    S.plan.sort((a, b) => a.date.localeCompare(b.date) || a.s - b.s);
    return { created, skipped, per };
  }

  // When nothing fits, figure out why, so @me can explain it and offer a fix.
  function diagnose(horizon = 21) {
    const T = today(), end = addDays(T, horizon);
    const all = liveItems(), future = all.filter(i => i.date >= T).sort((a, b) => a.date.localeCompare(b.date));
    if (!all.length) return { why: 'empty' };
    if (!future.length) return { why: 'past', newest: [...all].sort((a, b) => b.date.localeCompare(a.date))[0], courses: [...new Set(all.map(i => i.course))] };
    const soon = future.filter(i => i.date <= end);
    if (!soon.length) return { why: 'later', next: future[0] };
    const worth = soon.filter(t => needsPrep(t) && !(t.type !== 'assignment' && t.topics?.length && !t.topics.includes('Everything') && !keepTopics(t.course, t.topics).length));
    if (!worth.length) return { why: 'noprep', courses: [...new Set(soon.filter(t => levelOf(t.course) === 'none').map(t => t.course))], items: soon.filter(t => t.noPrep) };
    const days = weekdaysBetween(T, addDays(T, 20)).slice(0, 7);
    const free = days.reduce((a, d) => a + gaps(d).reduce((x, [s, e]) => x + (e - s) * 60, 0), 0);
    const anyShortSlot = days.some(d => findSlot(d, 30));
    if (free < 90 || !anyShortSlot) {   // no stretch long enough for even a 30-minute session
      const tally = {};
      for (const d of days) for (const e of eventsOn(d)) {
        const hrs = Math.max(0, Math.min(e.e, cutoff(d)) - Math.max(e.s, isWeekday(d) ? START : 10)); if (!hrs) continue;
        const key = e.gid ? 'g:' + e.title : e.rid ? 'r:' + e.rid : 'o:' + e.title;
        (tally[key] = tally[key] || { title: e.base || e.title, kind: e.kind, rid: e.rid, gid: e.gid, hrs: 0, days: new Set() }).hrs += hrs; tally[key].days.add(d);
      }
      const blockers = Object.values(tally).sort((a, b) => b.hrs - a.hrs).slice(0, 3).map(b => ({ ...b, days: b.days.size }));
      return { why: 'full', blockers, free: Math.round(free), studyDays: days.length };
    }
    return { why: 'tight', items: worth };
  }

  function clearUpcoming() {
    const T = today(), before = S.plan.length;
    S.plan = S.plan.filter(b => !(b.status === 'planned' && b.date >= T));
    return before - S.plan.length;
  }

  function relocate(b, fromDate) {
    const it = itemById(b.itemId), last = it ? lastDayFor(it) : addDays(fromDate || b.date, 7);
    for (const d of weekdaysBetween(fromDate || addDays(b.date, 1), last)) {
      if (studyMinsOn(d) + minsOf(b) > capFor(d)) continue;
      const s = findSlot(d, minsOf(b), b.id); if (s) return { d, s };
    }
    return null;
  }

  // Moves planned sessions that now clash with something (new busy time, earlier bedtime, etc).
  function resolveConflicts() {
    const moved = [], dropped = [];
    for (const b of S.plan.filter(x => x.status === 'planned' && x.date >= today())) {
      if (fits(b, b.s, b.e)) continue;
      let slot = findSlot(b.date, minsOf(b), b.id), d = b.date;
      if (!slot) { const r = relocate(b); if (r) { d = r.d; slot = r.s; } }
      if (slot) { b.date = d; b.s = slot.s; b.e = slot.e; moved.push(b); } else { b.status = 'removed'; dropped.push(b); }
    }
    return { moved, dropped };
  }

  // Surprise quizzes get short, focused prep on the last day or two, even if those days are busy.
  function surprisePrep(it) {
    if (!needsPrep(it)) return [];
    const tp = it.topics.length ? it.topics : ['Key concepts'];
    const picks = [];
    for (const d of weekdaysBetween(today(), it.date).slice(-3).reverse()) {
      if (picks.length >= 2) break;
      if (studyMinsOn(d) >= 240) continue;
      const len = d === it.date ? 20 : 30;
      const slot = findSlot(d, len, null, d === it.date ? (it.time ?? cutoff(d)) - 0.1 : undefined);
      if (slot) picks.push({ d, slot });
    }
    const created = picks.reverse().map((x, j) => {
      const t = tp[j % tp.length], same = x.d === it.date;
      const b = blockFor(it, x.d, x.slot, same ? `Quick cram: ${t}` : `Surprise quiz prep: ${t}`, [t], same ? 'review' : 'extra',
        same ? '20 focused minutes right before the quiz' : `30 minutes on ${t} so the surprise isn't scary`);
      b.score = 3; b.stype = same ? 'review' : 'concepts'; S.plan.push(b); return b;
    });
    S.plan.sort((a, b) => a.date.localeCompare(b.date) || a.s - b.s);
    return created;
  }

  // Adds a course and its dated items from a syllabus, Canvas, or chat.
  function mergeCourse(data) {
    const code = String(data.course?.code || data.course?.name || 'Course').slice(0, 16).trim();
    let c = S.courses.find(x => x.code.toLowerCase() === code.toLowerCase());
    if (!c) { c = { code, name: String(data.course?.name || '').slice(0, 40), source: data.source === 'canvas' ? 'Canvas' : data.source === 'chat' ? 'you' : 'syllabus' }; S.courses.push(c); }
    if (data.canvasId && !c.canvasId) c.canvasId = data.canvasId;
    let meet = 0, added = 0, skipped = 0; const newItems = [];
    for (const m of data.meetings || []) {
      const days = (m.days || []).map(x => String(x).slice(0, 3).toLowerCase()).filter(x => WK.includes(x));
      const s = parseHM(m.start), e = parseHM(m.end);
      if (!days.length || s == null || e == null || e <= s) continue;
      if (S.routine.some(r => r.course === code && r.s === s && r.days.join() === days.join())) continue;
      S.routine.push({ id: uid('r'), days, s, e, title: `${code} ${m.label || 'class'}`, course: code }); meet++;
    }
    for (const it of data.items || []) {
      if (!it.name || !/^\d{4}-\d{2}-\d{2}$/.test(it.date || '')) { skipped++; continue; }
      if (S.items.some(x => (it.canvasId && x.canvasId === it.canvasId) || (x.course === code && x.name === it.name && x.date === it.date))) { skipped++; continue; }
      const type = ['exam', 'quiz', 'assignment'].includes(it.type) ? it.type : 'assignment';
      let time = typeof it.time === 'number' ? it.time : parseHM(it.time); if (time != null && time >= 23.9) time = null;
      S.items.forEach(x => x.isNew = false);
      const item = {
        id: uid('i'), course: code, name: String(it.name).slice(0, 60), type, date: it.date, time, dur: it.dur || null,
        weight: Number(it.weight) > 0 && Number(it.weight) <= 100 ? Math.round(Number(it.weight) * 10) / 10 : null,
        topics: (Array.isArray(it.topics) ? it.topics : []).map(t => String(t).slice(0, 40)).filter(Boolean).slice(0, 12),
        source: data.source, status: 'active', isNew: true, canvasId: it.canvasId || null, surprise: !!it.surprise, estimated: !!it.estimated,
        assigned: /^\d{4}-\d{2}-\d{2}$/.test(it.assigned || '') && it.assigned <= it.date ? it.assigned : null
      };
      if (item.time == null && (item.type === 'quiz' || item.type === 'exam')) {
        const day = S.routine.filter(r => r.course === code && r.days.includes(wkey(item.date)));
        const m = (item.type === 'exam' && day.find(lectureLike)) || day[0]; if (m && !isFinal(item)) item.time = m.s;
      }
      S.items.push(item); newItems.push(item); added++;
    }
    return { code, meet, added, skipped, newItems };
  }

  const allDayOn = date => (S.gevents?.[date] || []).filter(x => x.allDay);

  // Removes a class and everything @me planned for it.
  function removeCourse(code) {
    const ids = new Set(S.items.filter(i => i.course === code).map(i => i.id));
    S.courses = S.courses.filter(c => c.code !== code);
    S.items = S.items.filter(i => i.course !== code);
    S.routine = S.routine.filter(r => r.course !== code);
    S.plan.forEach(b => { if (ids.has(b.itemId) && b.status === 'planned') b.status = 'removed'; });
    return ids.size;
  }

  return {
    examSpan, isFinal, diagnose,
    STYPES, stypeOf, isCS, isProject, isStudyDay, capFor,
    allDayOn, removeCourse, coverage, lectureBefore, isSkipped, keepTopics, levelOf, needsPrep,
    active, liveItems, itemById, nextExam, eventsOn, cutoff, gaps, findSlot, fits, studyMinsOn, weekdaysBetween,
    sessionsFor, lastDayFor, blockFor, buildPlan, clearUpcoming, relocate, resolveConflicts, surprisePrep, mergeCourse,
    minsOf, DAILY_CAP, START
  };
}
