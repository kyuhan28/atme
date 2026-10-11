import { SITES } from './util.js';

const BASE_ID = 7100;

// Redirects distracting sites to @me's "blocked" page while a study session is running.
export async function enableFocus() {
  const rules = SITES.map((s, i) => ({
    id: BASE_ID + i,
    priority: 1,
    action: { type: 'redirect', redirect: { extensionPath: `/blocked.html?site=${encodeURIComponent(s.name)}` } },
    condition: { requestDomains: [s.domain], resourceTypes: ['main_frame'] }
  }));
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: rules.map(r => r.id), addRules: rules });
}

export async function disableFocus() {
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: SITES.map((_, i) => BASE_ID + i) });
}
