// Everything @me knows lives in chrome.storage.local, so the dashboard, popup,
// and background worker all share one source of truth.
const STATE_KEY = 'atme:state';
const SETTINGS_KEY = 'atme:settings';

export const defaultState = () => ({
  courses: [], items: [], routine: [], oneoff: [], plan: [],
  prefs: null,
  extras: { grades: true, focus: true, bedtime: 23, brief: 8, classCal: false, dueCal: false },
  ready: {}, quiz: {}, srs: {}, memory: [], studied: 0,
  used: { chem: false },
  step: 0,
  alerts: [], fresh: [],
  gbusy: {}, gbusyAt: 0,                 // fallback busy times by date: { 'YYYY-MM-DD': [[start, end], ...] }
  gevents: null,                         // Google Calendar events by date: { 'YYYY-MM-DD': [{ s, e, title, id, allDay }] }
  term: null,                            // current semester { name, start, end }
  gcal: { calendarId: null, map: {}, classCalId: null, classMap: {}, dueCalId: null, dueMap: {} },  // @me calendars and what we've written to them
  canvasSeen: [],                        // Canvas assignment ids we've already imported
  active: null,                          // running study session { id, start, end }
  askedTimes: false,                     // already asked about missing class times
  holidays: [],                          // days off: no classes at all on these dates
  ignoredG: [],                          // Google event ids @me shouldn't plan around
  askedGcal: false,                      // already offered to put classes and deadlines on Google Calendar
  materials: [],                         // course materials (slides, notes, old exams): the list; text is stored separately
  prof: {},                              // proficiency by topic, from real test scores: { 'CS 0445|Recursion': { pct, correct, total, hist } }
  profCollapsed: false,
  skipTopics: {},                        // topics marked not important: { 'CS 0445': ['Java Review'] }
  rev: 0
});

export const defaultSettings = () => ({
  geminiKey: '', geminiModel: 'gemini-flash-latest',
  canvasDomain: '', canvasToken: '',
  demoSessions: false
});

export async function loadState() {
  const r = await chrome.storage.local.get(STATE_KEY);
  return Object.assign(defaultState(), r[STATE_KEY] || {});
}

export async function saveState(S, from = 'app') {
  const data = {};
  for (const k of Object.keys(defaultState())) data[k] = S[k];
  data.rev = (S.rev || 0) + 1; S.rev = data.rev;
  await chrome.storage.local.set({ [STATE_KEY]: data });
  try { await chrome.runtime.sendMessage({ type: 'state-changed', from, rev: data.rev }); } catch (e) { /* no listeners open */ }
}

export async function loadSettings() {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  return Object.assign(defaultSettings(), r[SETTINGS_KEY] || {});
}

export async function saveSettings(patch) {
  const cur = await loadSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function resetAll() {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove([STATE_KEY, ...Object.keys(all).filter(k => k.startsWith('atme:mat:'))]);
}
