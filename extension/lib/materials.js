// Course materials (slides, notes, study guides, old exams) make quizzes sound like the actual class.
// The list lives in state (S.materials) so it shows up everywhere; the text itself is stored under its own key,
// so big slide decks don't slow down every save.
import { uid } from './util.js';

const KEY = id => `atme:mat:${id}`;
export const KINDS = { slides: 'Lecture slides', notes: 'My notes', guide: 'Study guide', exam: 'Old or practice exam', other: 'Other' };
export const MAX_CHARS = 60000;

// Topic words, singular, so "Stacks" also matches "stack".
const words = t => String(t).toLowerCase().replace(/[^a-z0-9+#& ]/g, ' ').split(/\s+/)
  .filter(w => w.length >= 4 && !/^(with|from|that|this|into|than|then|your|about|intro|review|part|lecture|chapter|notes)$/.test(w))
  .map(w => w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

// Which lecture topics a piece of text is about, by how often each topic's words show up.
export function autoTopics(text, topics) {
  const low = String(text).toLowerCase();
  const scored = topics.map(t => {
    const ws = words(t); if (!ws.length) return { t, n: 0 };
    const n = ws.reduce((a, w) => a + (low.split(w).length - 1), 0) / ws.length;
    return { t, n };
  }).filter(x => x.n >= 2).sort((a, b) => b.n - a.n);
  return scored.slice(0, 4).map(x => x.t);
}

export async function addMaterial(S, { course, name, kind, text, topics }) {
  const id = uid('m'), clean = String(text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_CHARS);
  if (clean.length < 40) throw new Error('That file didn\'t have enough text to use.');
  await chrome.storage.local.set({ [KEY(id)]: clean });
  const meta = { id, course, name: String(name || 'Untitled').slice(0, 60), kind: KINDS[kind] ? kind : 'other', topics: topics || [], chars: clean.length, at: Date.now() };
  S.materials = [...(S.materials || []), meta];
  return meta;
}
export async function removeMaterial(S, id) {
  S.materials = (S.materials || []).filter(m => m.id !== id);
  await chrome.storage.local.remove(KEY(id));
}
export async function textOf(id) { return (await chrome.storage.local.get(KEY(id)))[KEY(id)] || ''; }

// Materials for a course that match these topics, best first. Untagged materials count for every topic.
export function materialsFor(S, course, topics = []) {
  const list = (S.materials || []).filter(m => m.course === course);
  const rank = m => (m.kind === 'exam' ? 3 : 0) + (topics.length && m.topics.some(t => topics.includes(t)) ? 5 : 0) + (!m.topics.length ? 1 : 0);
  return list.filter(m => !topics.length || !m.topics.length || m.kind === 'exam' || m.topics.some(t => topics.includes(t))).sort((a, b) => rank(b) - rank(a));
}

// Pulls the parts of each material that talk about these topics, within a character budget.
export async function contextFor(S, course, topics = [], budget = 22000) {
  const mats = materialsFor(S, course, topics); if (!mats.length) return { text: '', used: [] };
  const keys = [...new Set(topics.flatMap(words))];
  const out = [], used = [];
  let left = budget;
  for (const m of mats) {
    if (left < 800) break;
    const full = await textOf(m.id); if (!full) continue;
    const share = Math.min(left, m.kind === 'exam' ? 8000 : Math.max(3000, Math.floor(budget / Math.min(mats.length, 4))));
    let piece;
    if (full.length <= share || !keys.length) piece = full.slice(0, share);
    else {
      // Keep the chunks (slides or paragraphs) that mention the topics, plus the one after for context.
      const chunks = full.split(/\n(?=Slide \d+:)|\n\s*\n/);
      const hit = new Set();
      chunks.forEach((c, i) => { const low = c.toLowerCase(); if (keys.some(k => low.includes(k))) { hit.add(i); hit.add(i + 1); } });
      piece = [...hit].sort((a, b) => a - b).map(i => chunks[i]).filter(Boolean).join('\n\n').slice(0, share) || full.slice(0, share);
    }
    out.push(`### ${m.name} (${KINDS[m.kind]})\n${piece}`); used.push(m.name); left -= piece.length;
  }
  return { text: out.join('\n\n'), used };
}

// Offline quiz from notes: "Which term matches this description?" using the student's own definitions.
export async function notesQuiz(S, course, topics, count = 3) {
  const mats = materialsFor(S, course, topics).filter(m => m.kind !== 'exam'); if (!mats.length) return null;
  const defs = [], seen = new Set();
  for (const m of mats) {
    const text = await textOf(m.id);
    for (const raw of text.split('\n')) {
      const line = raw.replace(/^\s*(?:[-•*▪◦]|\d+[.)])\s*/, '').trim();
      let mm = line.match(/^([A-Z][A-Za-z0-9 ()'\/+#-]{2,40}?)\s*(?::|–|—| - )\s+(.{20,170})$/);
      if (!mm) { const g = line.match(/^(?:An?|The)\s+([a-z][a-z0-9 -]{2,30}?)\s+is\s+((?:an?|the)\s+.{12,150}?)[.;]?$/i); if (g) mm = [line, g[1], g[2]]; }
      if (!mm) continue;
      const t0 = mm[1].trim(), term = t0[0].toUpperCase() + t0.slice(1), def = mm[2].trim().replace(/\.$/, '');
      if (/^(slide|speaker notes|due|note|example|exam|quiz|lab|project|chapter|week)\b/i.test(term) || seen.has(term.toLowerCase())) continue;
      seen.add(term.toLowerCase()); defs.push({ term, def, src: m.name, topic: m.topics.find(x => topics.includes(x)) || topics[0] || 'General' });
    }
  }
  if (defs.length < 4) return null;
  const shuffle = a => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  return shuffle(defs).slice(0, count).map(d => {
    const others = shuffle(defs.filter(x => x.term !== d.term)).slice(0, 3).map(x => x.term);
    const options = shuffle([d.term, ...others]);
    return { topic: d.topic, q: `Which term matches this description from your ${d.src}?\n"${d.def.length > 150 ? d.def.slice(0, 147) + '…' : d.def}"`, code: null, options, answer: options.indexOf(d.term), explain: `From ${d.src}: ${d.term}.` };
  });
}

export async function clearAll(S) {
  const keys = (S.materials || []).map(m => KEY(m.id));
  if (keys.length) await chrome.storage.local.remove(keys);
  S.materials = [];
}
