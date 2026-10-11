import { loadState } from './lib/store.js';
import { today, fmt, dLabel, relDay, esc } from './lib/util.js';

const $ = id => document.getElementById(id);
const open = q => chrome.runtime.sendMessage({ type: 'open-app', query: q || '' }).then(() => window.close());

const S = await loadState();
if (S.alerts.length) {
  $('alert').hidden = false;
  $('alert').innerHTML = `<b>❗ ${S.alerts.length} change${S.alerts.length > 1 ? 's' : ''} to review</b><br>${esc(S.alerts.at(-1).summary)}`;
  $('alert').onclick = () => open('?review=1');
}
const next = S.plan.filter(b => b.status === 'planned' && b.date >= today()).sort((a, b) => a.date.localeCompare(b.date) || a.s - b.s)[0];
const exam = S.items.filter(i => i.status !== 'cancelled' && i.type === 'exam' && i.date >= today()).sort((a, b) => a.date.localeCompare(b.date))[0];
$('next').innerHTML = !S.courses.length ? '<p>No classes yet. Open @me to import a syllabus or Canvas.</p>'
  : `${next ? `<p class="muted small">Next study session</p><p><b>${esc(next.title)}</b><br>${relDay(next.date) === 'today' ? 'Today' : dLabel(next.date)}, ${fmt(next.s)}</p>` : '<p>No sessions planned. Open @me to plan your week.</p>'}
     ${exam ? `<p class="muted small">Next exam</p><p>${esc(exam.course)} ${esc(exam.name)}<br>${dLabel(exam.date)}</p>` : ''}`;
$('open').onclick = () => open('?chat=1');
$('quiz').onclick = () => open('?surprise=1');
$('settings').onclick = () => chrome.runtime.openOptionsPage();
$('poll').onclick = async () => {
  $('pollMsg').textContent = 'Checking Canvas…';
  const r = await chrome.runtime.sendMessage({ type: 'poll-now' });
  $('pollMsg').textContent = r?.ok ? (r.found ? `Found ${r.found} new item${r.found > 1 ? 's' : ''}. Open @me to review.` : 'Nothing new. You\'re caught up!') : `Couldn't check: ${r?.reason || 'unknown error'}`;
};
