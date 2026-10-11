// Reads pasted (or Word) syllabus text without AI. It's simpler than the AI reader but catches the
// common patterns: "Lab 3 - Due 9/15", "Midterm (15%): 2025-10-14", "Tuesday 6:00-8:30PM",
// schedule rows like "9/30 | Recursion | Lab 6 - Due 10/6", holidays, and "@ 9% each" weights.
import { pad, today } from './util.js';

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const DAY = { mon: 'mon', tue: 'tue', tues: 'tue', wed: 'wed', thu: 'thu', thur: 'thu', thurs: 'thu', fri: 'fri', sat: 'sat', sun: 'sun' };
const DATE = /\b(?:(20\d{2})-(\d{1,2})-(\d{1,2})|(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?|(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?)\b/i;
const ITEM = /\b(final\s+(?:paper|project|essay|report|presentation|portfolio)|midterm(?:\s*(?:exam\s*)?\d)?|final(?:\s+exam)?|exam\s*\d*|test\s*\d+|quiz\s*\d+|lab\s+report\s*\d*|response\s+paper\s*\d*|lab\s*\d+|report\s*\d+|project\s*\d+|homework\s*\d+|hw\s*\d+|assignment\s*\d+|problem\s*set\s*\d+|ps\s*\d+|essay\s*\d*|paper\s*\d*|presentation\s*\d*|speech\s*\d*|reflection\s*\d*|outline\s*\d*)\b/i;
const OFF = /\b(no (lecture|class|classes)|holiday|thanksgiving|spring break|fall break|winter break|reading day|recess|no school)\b/i;

const typeOf = n => /paper|project|essay|report|presentation|portfolio/i.test(n) ? 'assignment' : /midterm|final|exam|test/i.test(n) ? 'exam' : /quiz/i.test(n) ? 'quiz' : 'assignment';
const tidy = n => n.replace(/\s+/g, ' ').trim().replace(/^(\w)/, c => c.toUpperCase()).replace(/\bhw\b/i, 'HW').replace(/\bps\b/i, 'PS');

function to24(h, m, ap, partnerAp) {
  h = +h; m = +(m || 0);
  const a = (ap || partnerAp || '').toLowerCase().replace(/\./g, '');
  if (a === 'pm' && h < 12) h += 12; if (a === 'am' && h === 12) h = 0;
  if (!a && h < 8) h += 12;                               // "3-4:15" with no am/pm is almost always afternoon
  return `${pad(h)}:${pad(m)}`;
}

export function readSyllabusText(text) {
  const src = String(text || '').replace(/\r/g, '');
  const lines = src.split('\n').map(l => l.trim()).filter(Boolean);
  const season = src.match(/\b(spring|summer|fall|autumn|winter)\s+(20\d{2})\b/i);
  const baseYear = season ? +season[2] : +today().slice(0, 4);
  const term = season ? season[1].toLowerCase() : '';
  const yearFor = m => term.startsWith('fall') || term === 'autumn' ? (m < 6 ? baseYear + 1 : baseYear) : term === 'spring' ? (m > 8 ? baseYear - 1 : baseYear) : baseYear;
  const parseDate = s => {
    const m = String(s).match(DATE); if (!m) return null;
    let y, mo, d;
    if (m[1]) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if (m[4]) { mo = +m[4]; d = +m[5]; y = m[6] ? (m[6].length === 2 ? 2000 + +m[6] : +m[6]) : yearFor(mo); }
    else { mo = MON[m[7].toLowerCase().slice(0, 4)] || MON[m[7].toLowerCase().slice(0, 3)]; d = +m[8]; y = m[9] ? +m[9] : yearFor(mo); }
    if (!mo || mo > 12 || !d || d > 31) return null;
    return `${y}-${pad(mo)}-${pad(d)}`;
  };

  // Subject codes can be up to 7 letters (Pitt's COMMRC, for example). Prefer the first line that has one.
  const codeRe = /\b([A-Z]{2,7})\s?-?(\d{3,4}[A-Z]?)\b/;
  const codeLine = lines.slice(0, 6).find(l => codeRe.test(l) && !/\b(room|hall|bldg|building)\b/i.test(l));
  let codeM = (codeLine || src).match(codeRe), code = codeM ? `${codeM[1]} ${codeM[2]}` : 'Course';
  let codeLineUsed = codeLine;
  if (!codeM) {
    const loose = /\b([A-Z][A-Za-z]{1,9})(?:-([A-Z]{2}))?\s?(\d{1,3}[A-Z]{0,2})\b/;
    const stop = /^(fall|spring|summer|winter|week|room|section|lab|quiz|exam|midterm|final|chapter|unit|project|problem|lecture|homework|paper|part|module|day|class|version|assignment|test|ch|no|vol|page|step|phase|hw|ps|grade|level)$/i;
    for (const l of lines.slice(0, 3)) {
      const m = l.match(loose);
      if (m && !stop.test(m[1])) { codeM = m; codeLineUsed = l; code = `${m[1].toUpperCase()}${m[2] ? '-' + m[2] : ''} ${m[3]}`; break; }
    }
  }
  const nameLine = lines.find(l => l.length > 6 && l.length < 70 && !DATE.test(l) && !/@|http|syllabus is provided|all times/i.test(l) && /[a-z]/.test(l));

  // weights: "Midterm (15%)", "Five (5) projects @ 9% each", "Thirteen (13) labs @ 2% each"
  const each = {};
  for (const m of src.matchAll(/\b(projects?|labs?|quizzes|quiz|homeworks?|assignments?|problem sets?|essays?|papers?|exams?|speech(?:es)?|presentations?|reflections?|outlines?)\b[^\n%]{0,40}?(\d+(?:\.\d+)?)\s*%\s*each/gi)) each[m[1].toLowerCase().replace(/quizzes$/, 'quiz').replace(/speeches$/, 'speech').replace(/s$/, '')] = +m[2];
  const named = {};
  for (const m of src.matchAll(/\b(midterm(?:\s*\d)?|final(?:\s+exam)?)\s*\((\d+(?:\.\d+)?)\s*%\)/gi)) named[m[1].toLowerCase().replace(/\s+exam$/, '')] = +m[2];
  const weightOf = n => {
    const k = n.toLowerCase().replace(/\s*\d+$/, '').replace(/\s+exam$/, '').trim();
    if (named[n.toLowerCase().replace(/\s+exam$/, '')] != null) return named[n.toLowerCase().replace(/\s+exam$/, '')];
    if (named[k] != null) return named[k];
    const cat = k.replace(/^problem set$/, 'problem set').replace(/^hw$/, 'homework').replace(/^ps$/, 'problem set');
    return each[cat] ?? null;
  };

  // weekly meetings: "Tuesday 6:00-8:30PM", "MWF 10:20-11:15", "Recitation: Th 4-4:50PM"
  const meetings = [];
  // Day words in any case ("Tuesday", "tues"), letter codes in capitals only ("MWF", "TTh"), am/pm in any case.
  const DW = '(?:[Mm]on|[Tt]ues?|[Ww]ed|[Tt]hu(?:rs?)?|[Ff]ri|[Ss]at|[Ss]un)[a-z]*';
  const D2 = '(?:Mo|Tu|We|Th|Fr|Sa|Su)';
  const AP = '([AaPp]\\.?[Mm]\\.?)';
  const MEET = new RegExp(String.raw`\b(${DW}(?:\s*(?:,|\/|&|and)\s*${DW})*|${D2}(?:\s*\/?\s*${D2})+|[MTWRF]{1,5}|T(?:u)?Th|Th|Tu)\s+(\d{1,2})(?::(\d{2}))?\s*${AP}?\s*(?:-|–|to)\s*(\d{1,2})(?::(\d{2}))?\s*${AP}?`, 'g');
  const D2MAP = { mo: 'mon', tu: 'tue', we: 'wed', th: 'thu', fr: 'fri', sa: 'sat', su: 'sun' };
  const cleanDetail = s => s.replace(/^[\s,;:()\-–]*(?:or|and)?\s*/i, '').replace(/^(?:class\s+meets|meets|lectures?|labs?|recitations?|discussions?(?:\s+sections?)?)\b\s*:?\s*/i, '').replace(/^(?:in|at)\s+/i, '')
    .replace(/[\s,;:\-–]*(?:or|and)?[\s,;:\-–]*$/i, '').replace(/^\((.*)\)$/, '$1').replace(/\s*:\s*(,|$)/g, '$1').replace(/\s{2,}/g, ' ').trim()
    .replace(/^([^(]*)\)$/, '$1').replace(/^\(([^)]*)$/, '$1');   // drop a stray parenthesis left from "(Section 1010) or"
  for (const line of lines) {
    if (/office hours?/i.test(line)) continue;
    const found = [...line.matchAll(MEET)];
    for (const [mi, m] of found.entries()) {
      const raw = m[1], days = [];
      if (new RegExp(`^${D2}(?:\\s*\\/?\\s*${D2})+$`).test(raw)) { for (const tok of raw.replace(/[\s/]/g, '').match(/.{2}/g)) days.push(D2MAP[tok.toLowerCase()]); }
      else if (/^[MTWRF]{1,5}$/.test(raw)) { let i = 0; while (i < raw.length) { const ch = raw[i]; if (ch === 'T' && raw[i + 1] === 'h') { days.push('thu'); i += 2; } else { days.push({ M: 'mon', T: 'tue', W: 'wed', R: 'thu', F: 'fri' }[ch]); i++; } } }
      else if (/^TTh$/i.test(raw)) days.push('tue', 'thu');
      else if (/^Th$/i.test(raw)) days.push('thu');
      else if (/^Tu$/i.test(raw)) days.push('tue');
      else for (const w of raw.toLowerCase().split(/\s*(?:,|\/|&|and)\s*/)) { const k = DAY[w.slice(0, 5)] || DAY[w.slice(0, 4)] || DAY[w.slice(0, 3)]; if (k) days.push(k); }
      if (!days.length) continue;
      const end = to24(m[5], m[6], m[7]), start = to24(m[2], m[3], m[4], m[7]);
      if (start >= end) continue;
      const label = /recitation/i.test(line) ? 'recitation' : /\blab\b/i.test(line) && !/due/i.test(line) ? 'lab' : /discussion/i.test(line) ? 'discussion' : 'lecture';
      // What's left of the line, like "Section 002, Room 120" or "5505 SSQ", minus leftover punctuation.
      // Text around this time, like "Section 002, Room 120": what comes before the first time on the line,
      // plus what comes after this one, up to the next time.
      const pre = mi === 0 ? cleanDetail(line.slice(0, m.index)) : '';
      const post = cleanDetail(line.slice(m.index + m[0].length, found[mi + 1]?.index ?? line.length));
      const detail = [pre, post].filter(Boolean).join(', ').slice(0, 40);
      if (!meetings.some(x => x.days.join() === days.join() && x.start === start)) meetings.push({ days: [...new Set(days)], start, end, label, detail });
    }
  }
  const byLabel = {}; meetings.forEach(m => (byLabel[m.label] = (byLabel[m.label] || 0) + 1));
  meetings.forEach(m => { m.choose_one = m.label !== 'lecture' && byLabel[m.label] > 1; });

  // dated items, lecture topics, and days off
  const items = [], lectures = [], noClass = [];
  const addItem = (name, date, assigned, extra = {}) => {
    name = tidy(name); if (!date) return;
    if (items.some(i => i.name.toLowerCase() === name.toLowerCase() && i.date === date)) return;
    // "Final (15%)" in grading and "Final Exam" in the schedule are the same exam: keep one, with the fuller name.
    const twin = typeOf(name) === 'exam' && items.find(i => i.type === 'exam' && i.date === date);
    if (twin) { if (name.length > twin.name.length) twin.name = name; return; }
    items.push({ name, type: typeOf(name), date, time: extra.time || null, dur: extra.dur || null, weight: extra.weight ?? weightOf(name), topics: [], assigned: assigned && assigned <= date ? assigned : null });
  };
  for (const line of lines) {
    // schedule rows that start with a date: "9/30 | Recursion | Lab 6 - Due 10/6" or "9/30 Recursion Lab 6 - Due 10/6"
    const lead = line.match(new RegExp('^' + DATE.source + String.raw`\s*[|:\-–]?\s*(.*)$`, 'i'))
      || line.match(new RegExp(String.raw`^(?:week|wk\.?)\s*\d+\s*[(,:\-–]?\s*(?:of\s+)?` + DATE.source + String.raw`\)?\s*[|:\-–]?\s*(.*)$`, 'i'));
    const rowDate = lead ? parseDate(lead[0]) : null;
    // "Lab 3 - Due 9/15", "Project 1 - Due 9/29", "Midterm (15%): 2025-10-14". On a schedule row, the row's date is when it's assigned.
    const WD = String.raw`(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?`;
    for (const m of line.matchAll(new RegExp(ITEM.source + String.raw`[^\n|]{0,30}?(?:due|:|on|-|–)\s*` + WD + DATE.source, 'gi'))) {
      const wt = m[0].match(/\((\d+(?:\.\d+)?)\s*%\)/), after = line.slice(m.index + m[0].length);
      const tr = after.match(new RegExp(String.raw`^\s*,?\s*(?:at\s*|from\s*)?(\d{1,2})(?::(\d{2}))?\s*${AP}?\s*(?:-|–|to)\s*(\d{1,2})(?::(\d{2}))?\s*${AP}`, 'i'));
      const t1 = after.match(new RegExp(String.raw`^\s*,?\s*(?:at|by)\s*(\d{1,2})(?::(\d{2}))?\s*${AP}`, 'i'));
      const extra = { weight: wt ? +wt[1] : undefined };
      if (tr) { const s = to24(tr[1], tr[2], tr[3], tr[6]), e = to24(tr[4], tr[5], tr[6]); const sh = +s.slice(0, 2) + +s.slice(3) / 60, eh = +e.slice(0, 2) + +e.slice(3) / 60; if (eh > sh) { extra.time = s; extra.dur = Math.round((eh - sh) * 100) / 100; } }
      else if (t1) extra.time = to24(t1[1], t1[2], t1[3]);
      addItem(m[1], parseDate(m[0].slice(m[1].length)), rowDate, extra);
    }
    if (!lead) continue;
    const date = parseDate(lead[0]), rest = lead[lead.length - 1] || '';
    if (!date || !rest) continue;
    const first = rest.split('|')[0].trim();
    const topic = first.split(new RegExp(String.raw`\s+(?=` + ITEM.source + String.raw`\s*[-–:]|no (?:lab|recitation))`, 'i'))[0].replace(/\s+/g, ' ').trim();
    if (OFF.test(topic)) { noClass.push(date); continue; }
    if (/^(midterm|final|exam|test)\b/i.test(topic)) { addItem(topic.replace(/\s+no\b.*$/i, '').slice(0, 30), date); continue; }
    if (topic && topic.length >= 3 && !/^(due|lab|project|homework|hw)\b/i.test(topic)) lectures.push({ date, topic: topic.slice(0, 40) });
  }
  const all = [...items.map(i => i.date), ...lectures.map(l => l.date)].sort();
  return {
    course: { code, name: (() => {
      // The name is often on the same line as the code: "COMMRC 0520 Public Speaking".
      const withCode = codeLineUsed && codeLineUsed.replace(codeM?.[0] || '', '').replace(/\(\d+\)|[-–:|,]+/g, ' ').replace(/\b(fall|spring|summer|winter)\s+20\d{2}\b/i, '').replace(/\s+/g, ' ').trim();
      if (withCode && withCode.length >= 4 && /[a-z]/.test(withCode)) return withCode.slice(0, 50);
      return nameLine && !nameLine.includes(codeM?.[0] || '@@') ? nameLine.slice(0, 50) : '';
    })() },
    term: { name: season ? `${season[1][0].toUpperCase()}${season[1].slice(1).toLowerCase()} ${baseYear}` : '', start: all[0] || null, end: all.at(-1) || null },
    meetings, lectures, no_class: [...new Set(noClass)], items, readWithoutAI: true
  };
}
