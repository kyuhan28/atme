import { loadState } from './lib/store.js';

const site = new URLSearchParams(location.search).get('site') || 'This site';
document.getElementById('h').textContent = `${site} is blocked right now`;
const S = await loadState();
const b = S.active && S.plan.find(x => x.id === S.active.id);
const tick = () => {
  if (!S.active) { document.getElementById('t').textContent = 'Your session just ended, so this will work again on reload.'; return; }
  const left = Math.max(0, Math.ceil((S.active.end - Date.now()) / 60e3));
  document.getElementById('t').textContent = `You've got ${left} minute${left !== 1 ? 's' : ''} left in "${b?.title || 'your study session'}". Stay with it, you're doing great.`;
};
tick(); setInterval(tick, 15e3);
document.getElementById('back').onclick = () => chrome.runtime.sendMessage({ type: 'open-app' });
