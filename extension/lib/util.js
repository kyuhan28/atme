// Shared helpers used by the dashboard, popup, and background worker. No DOM access here.
export const pad = n => String(n).padStart(2, '0');
export const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fromIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = fromIso(s); d.setDate(d.getDate() + n); return iso(d); };
export const today = () => iso(new Date());
export const nowH = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; };
export const WK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const DAYNAME = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
export const wkey = s => WK[fromIso(s).getDay()];
export const isWeekday = s => { const g = fromIso(s).getDay(); return g > 0 && g < 6; };
export const nextWeekday = s => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '') || isNaN(fromIso(s))) s = today();
  for (let i = 0; i < 7 && !isWeekday(s); i++) s = addDays(s, 1);
  return s;
};
export const mondayOf = s => { const d = fromIso(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); };
export const dayDiff = (a, b) => Math.round((fromIso(b) - fromIso(a)) / 864e5);
export const dLabel = s => fromIso(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
export const dShort = s => fromIso(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
export const dWeekday = s => fromIso(s).toLocaleDateString('en-US', { weekday: 'long' });
export const fmt = h => { const hr = Math.floor(h), m = Math.round((h - hr) * 60), h24 = hr % 24; return `${((h24 + 11) % 12) + 1}:${pad(m)} ${h24 >= 12 ? 'PM' : 'AM'}`; };
export const parseHM = t => { if (t == null || t === '') return null; const m = String(t).match(/^(\d{1,2}):(\d{2})/); return m ? (+m[1]) + (+m[2]) / 60 : null; };
export const toHM = h => `${pad(Math.floor(h))}:${pad(Math.round((h % 1) * 60))}`;
export const relDay = s => { const d = dayDiff(today(), s); return d === 0 ? 'today' : d === 1 ? 'tomorrow' : dLabel(s); };
export const when = b => `${dLabel(b.date)}, ${fmt(b.s)} to ${fmt(b.e)}`;
export const mins = b => Math.round((b.e - b.s) * 60);
export const hrs = m => (m / 60).toFixed(1).replace('.0', '') + 'h';
export const tod = s => s < 12 ? 'Morning' : s < 17 ? 'Afternoon' : 'Evening';
export const daysTxt = ds => ds.map(d => DAYNAME[d]).join('/');
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const uid = p => p + Math.random().toString(36).slice(2, 9);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
// A Date for a calendar date plus a decimal hour, in the user's local time.
export const dateAt = (date, h) => { const d = fromIso(date); d.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0); return d; };
export const shortName = t => t.name.split(':')[0].replace(/\s*\(.*\)$/, '').slice(0, 22);
export const SITES = [
  { name: 'YouTube', domain: 'youtube.com' }, { name: 'Instagram', domain: 'instagram.com' },
  { name: 'TikTok', domain: 'tiktok.com' }, { name: 'Reddit', domain: 'reddit.com' }
];
