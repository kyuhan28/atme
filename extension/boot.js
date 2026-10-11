// Loads before app.js. If @me fails to start (usually because files from different versions got mixed),
// this shows what went wrong instead of a blank page.
(() => {
  const REQUIRED = ['app.js', 'app.css', 'lib/util.js', 'lib/store.js', 'lib/ai.js', 'lib/planner.js', 'lib/gcal.js', 'lib/canvas.js', 'lib/sample.js', 'lib/docx.js', 'lib/textsyl.js', 'lib/csbank.js', 'lib/materials.js', 'lib/focus.js'];
  let shown = false;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function missingFiles() {
    const out = [];
    for (const f of REQUIRED) { try { const r = await fetch(chrome.runtime.getURL(f), { cache: 'no-store' }); if (!r.ok) out.push(f); } catch { out.push(f); } }
    return out;
  }
  async function show(detail) {
    if (shown || window.__atmeReady) return; shown = true;
    const missing = await missingFiles();
    const version = (() => { try { return chrome.runtime.getManifest().version; } catch { return '?'; } })();
    const box = document.createElement('div'); box.id = 'bootErr'; box.setAttribute('role', 'alertdialog');
    box.innerHTML = `<div class="be-box"><h2>@me couldn't start</h2>
      <p>${missing.length ? `These files are missing from your extension folder: <b>${missing.map(esc).join(', ')}</b>.` : 'Something went wrong while starting. This usually means files from different versions of @me got mixed together.'}</p>
      <p class="be-fix"><b>How to fix it:</b> replace everything in your <code>extension</code> folder with the files from the latest <code>atme.zip</code>, but keep your own <code>manifest.json</code> so your Google client ID stays. Then click the reload arrow on @me at <code>chrome://extensions</code>.</p>
      ${detail ? `<details><summary>Technical details (version ${esc(version)})</summary><pre>${esc(detail)}</pre></details>` : ''}
      <div class="be-btns"><button id="beReload">Try again</button></div></div>`;
    document.body.appendChild(box);
    document.getElementById('beReload').onclick = () => location.reload();
  }
  // Capture phase also catches a module file that fails to load.
  window.addEventListener('error', e => {
    // Only script problems count. A web font or image failing to load (like when offline) is fine.
    if (!(e instanceof ErrorEvent) && !(e.target instanceof HTMLScriptElement)) return;
    const where = e.filename ? `${e.filename.split('/').slice(-2).join('/')}:${e.lineno}` : (e.target?.src ? `couldn't load ${e.target.src.split('/').pop()}` : '');
    show(`${e.message || 'Load error'}${where ? `\n${where}` : ''}`);
  }, true);
  window.addEventListener('unhandledrejection', e => show(String(e.reason?.stack || e.reason || '').slice(0, 800)));
  setTimeout(() => show('@me took too long to start.'), 10000);
})();
