/*
 * app.js — the "22" PWA controller (serverless / gist-backed).
 *
 * Data source: a private GitHub Gist via gist-store.js (no server). The wear
 * math lives in WearCore. The flow:
 *   - First run: setup screen collects a gist-scope token, creates a gist.
 *   - Toggle/edit: applyEvent locally (optimistic) -> persist whole log to gist.
 *   - Load/refresh/visibility/interval: read gist (cache-busted) -> derive ->
 *     render. Offline: render from the local cache; queue writes; flush later.
 */
(function () {
  'use strict';
  const Core = window.WearCore;
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles';
  const RING_R = 108, RING_CIRC = 2 * Math.PI * RING_R;

  // ---- persistent settings + offline cache --------------------------------
  const LS = {
    gistId: 'aligners.gistId', token: 'aligners.token',
    log: 'aligners.log.v1', queueDirty: 'aligners.dirty',
  };
  const get = (k) => localStorage.getItem(k);
  const set = (k, v) => localStorage.setItem(k, v);
  const loadLocalLog = () => { try { return JSON.parse(get(LS.log)) || []; } catch (_) { return []; } };
  const saveLocalLog = (log) => set(LS.log, JSON.stringify(log));

  let store = GistStore.makeStore({ gistId: get(LS.gistId), token: get(LS.token) });
  let online = true, snap = null, tickTimer = null, pushing = false;

  const $ = (id) => document.getElementById(id);
  const appEl = $('app'), setupEl = $('setup');
  const els = {};
  ['toggle','ringFill','stateLabel','bigValue','bigCaption','actionHint','wornToday','outToday',
   'targetLabel','historyStrip','conn','lastSync','settingsBtn','shortcutHelp',
   'editToggle','editPanel','editType','editTime','editAdd','eventList',
   'setupToken','setupGistId','setupCreate','setupUseExisting','setupStatus'
  ].forEach(id => els[id] = $(id));

  // ---- formatting ----
  const fmtHM = (min) => { min = Math.max(0, Math.round(min)); const h = Math.floor(min/60), m = min%60;
    return h ? `${h}h ${String(m).padStart(2,'0')}m` : `${m}m`; };
  const fmtMs = (ms) => fmtHM(ms/60000);

  // ---- screen routing ------------------------------------------------------
  function showSetup() { setupEl.hidden = false; appEl.hidden = true; }
  function showApp() { setupEl.hidden = true; appEl.hidden = false; }

  // ---- setup flow ----------------------------------------------------------
  async function doCreate() {
    const token = (els.setupToken.value || '').trim();
    if (!token) { setupMsg('Paste your gist token first.', true); return; }
    setupMsg('Checking token…');
    const s = GistStore.makeStore({ token });
    const v = await s.validateToken();
    if (!v.ok) { setupMsg('That token didn’t work (need the “gist” scope). ' + (v.status === 401 ? 'Unauthorized.' : ''), true); return; }
    setupMsg('Creating your private log…');
    try {
      const id = await s.createGist('22 aligners — wear-time event log');
      set(LS.token, token); set(LS.gistId, id);
      store = GistStore.makeStore({ gistId: id, token });
      setupMsg('Done! Starting…');
      await enterApp();
    } catch (e) { setupMsg('Could not create the gist: ' + e.message, true); }
  }

  async function doUseExisting() {
    const token = (els.setupToken.value || '').trim();
    const gid = (els.setupGistId.value || '').trim();
    if (!token || !gid) { setupMsg('Need both a token and a gist id.', true); return; }
    setupMsg('Connecting…');
    const s = GistStore.makeStore({ token, gistId: gid });
    try {
      await s.read(); // verifies access + that it parses
      set(LS.token, token); set(LS.gistId, gid);
      store = s;
      await enterApp();
    } catch (e) { setupMsg('Couldn’t read that gist: ' + e.message, true); }
  }

  function setupMsg(t, isErr) {
    els.setupStatus.textContent = t;
    els.setupStatus.style.color = isErr ? 'var(--red)' : 'var(--muted)';
  }

  async function enterApp() {
    showApp();
    render(localSnapshot());
    await refresh();
    startTick();
  }

  // ---- snapshot from whatever log we have ----------------------------------
  function localSnapshot() { return Core.deriveSnapshot(loadLocalLog(), Date.now(), TZ, {}); }
  function setOnline(v) { online = v; els.conn.classList.toggle('off', !v); els.conn.title = v ? 'Synced' : 'Offline (queued)'; }

  // ---- the toggle ----------------------------------------------------------
  async function toggle() {
    const cur = snap ? snap.state : Core.currentState(loadLocalLog());
    const type = cur === 'IN' ? 'OUT' : 'IN';
    const ev = { type, at: Date.now(), src: 'tap', id: Core.makeId(Date.now()) };
    const r = Core.applyEvent(loadLocalLog(), ev, Date.now());
    if (!r.applied) return;
    saveLocalLog(r.log);
    render(localSnapshot());
    if (navigator.vibrate) navigator.vibrate(type === 'OUT' ? 20 : [15, 40, 15]);
    await persist();
  }

  // Persist the local log to the gist (read-modify-merge to avoid clobbering
  // events logged elsewhere, e.g. by Siri, since we were last in sync).
  async function persist() {
    if (pushing) return;
    pushing = true;
    try {
      const remote = await store.read();           // cache-busted
      const merged = mergeLogs(remote.state.log, loadLocalLog());
      const saved = await store.appendLog(merged);
      saveLocalLog(saved.log);
      set(LS.queueDirty, '0');
      setOnline(true);
      render(Core.deriveSnapshot(saved.log, Date.now(), TZ, {}));
    } catch (e) {
      set(LS.queueDirty, '1');                       // mark we owe a write
      setOnline(false);
    } finally { pushing = false; }
  }

  // Union two event logs by id; order by time. (Idempotent + dedup.)
  function mergeLogs(a, b) {
    const byId = new Map();
    for (const e of [...(a || []), ...(b || [])]) if (e && e.id) byId.set(e.id, e);
    return Core.sortLog([...byId.values()]);
  }

  // ---- refresh from gist ---------------------------------------------------
  async function refresh() {
    if (!store.isConfigured()) { showSetup(); return; }
    try {
      const remote = await store.read();
      // If we have unflushed local writes, merge + push them.
      if (get(LS.queueDirty) === '1') {
        const merged = mergeLogs(remote.state.log, loadLocalLog());
        const saved = await store.appendLog(merged);
        saveLocalLog(saved.log); set(LS.queueDirty, '0');
        setOnline(true);
        render(Core.deriveSnapshot(saved.log, Date.now(), TZ, {}));
        return;
      }
      saveLocalLog(remote.state.log);
      setOnline(true);
      render(Core.deriveSnapshot(remote.state.log, Date.now(), TZ, {}));
    } catch (e) {
      setOnline(false);
      render(localSnapshot());
    }
  }

  // ---- render --------------------------------------------------------------
  function render(s) {
    if (!s) return;
    snap = s;
    const out = s.state === 'OUT';
    const warn = out && (s.budgetRemainingMs <= 30 * 60000);
    appEl.classList.toggle('is-out', out);
    appEl.classList.toggle('is-warn', warn);
    els.stateLabel.textContent = s.state;
    els.targetLabel.textContent = (s.wornTargetH || 22) + 'h';
    els.wornToday.textContent = fmtHM(s.wornMinToday);
    els.outToday.textContent = fmtHM(s.outMinToday);

    if (out) {
      const leftMs = s.budgetRemainingMs;
      if (s.overBudget) {
        els.bigValue.textContent = '+' + fmtMs(-leftMs);
        els.bigCaption.textContent = 'over budget';
        els.actionHint.textContent = 'Put them back in now 🚨';
      } else {
        els.bigValue.textContent = fmtMs(leftMs);
        els.bigCaption.textContent = 'out-budget left';
        els.actionHint.textContent = 'Tap when you put them back in';
      }
    } else {
      els.bigValue.textContent = fmtHM(Math.max(0, s.budgetRemainingMin));
      els.bigCaption.textContent = 'out-budget left';
      els.actionHint.textContent = 'Tap when you take them out';
    }

    const frac = Core.clamp(s.budgetRemainingMs / (s.targetOutMin * 60000), 0, 1);
    els.ringFill.style.strokeDasharray = RING_CIRC.toFixed(1);
    els.ringFill.style.strokeDashoffset = (RING_CIRC * (1 - frac)).toFixed(1);

    renderHistory(s.history || []);
    renderEventList();
    els.lastSync.textContent = (online ? 'synced ' : 'offline ') + new Date(s.nowMs || Date.now()).toLocaleTimeString();
  }

  function renderHistory(history) {
    const days = history.slice().reverse();
    const maxWorn = Math.max(22 * 60, ...days.map(d => d.wornMin || 0), 1);
    els.historyStrip.innerHTML = '';
    if (!days.length) { els.historyStrip.innerHTML = '<p style="color:var(--muted);font-size:13px;margin:0">No history yet.</p>'; return; }
    for (const d of days) {
      const pct = Math.max(6, Math.round((d.wornMin / maxWorn) * 100));
      const wd = new Date(d.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' })[0];
      const div = document.createElement('div');
      div.className = 'hbar' + (d.hitTarget ? '' : ' miss');
      div.innerHTML = `<div class="hrs">${Math.floor(d.wornMin/60)}h</div><div class="bar" style="height:${pct}px"></div><div class="day">${wd}</div>`;
      div.title = `${d.date}: worn ${fmtHM(d.wornMin)}, out ${fmtHM(d.outMin)}`;
      els.historyStrip.appendChild(div);
    }
  }

  // ---- live countdown tick (visual only) ----------------------------------
  function startTick() {
    stopTick();
    tickTimer = setInterval(() => {
      if (!snap || snap.state !== 'OUT' || !snap.currentWindowStartedAt) return;
      const elapsedSinceSnap = Math.max(0, Date.now() - (snap.nowMs || Date.now()));
      const cap = snap.targetOutMin * 60000;
      const leftMs = Math.min(cap, snap.budgetRemainingMs - elapsedSinceSnap);
      const over = leftMs < 0;
      els.bigValue.textContent = (over ? '+' : '') + fmtMs(Math.abs(leftMs));
      els.bigCaption.textContent = over ? 'over budget' : 'out-budget left';
      appEl.classList.toggle('is-warn', leftMs <= 30 * 60000);
      els.ringFill.style.strokeDashoffset = (RING_CIRC * (1 - Core.clamp(leftMs / cap, 0, 1))).toFixed(1);
    }, 1000);
  }
  function stopTick() { if (tickTimer) clearInterval(tickTimer); tickTimer = null; }

  // ---- manual editing ------------------------------------------------------
  function renderEventList() {
    const log = Core.sortLog(loadLocalLog());
    const today = Core.localDayString(Date.now(), TZ);
    const [lo, hi] = Core.dayBounds(today, TZ);
    const todays = log.filter(e => e.at >= lo && e.at < hi);
    els.eventList.innerHTML = '';
    if (!todays.length) { els.eventList.innerHTML = '<li style="justify-content:center;color:var(--muted)">No events today</li>'; return; }
    for (const e of todays) {
      const li = document.createElement('li');
      const t = new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      li.innerHTML = `<span><span class="ev-type ${e.type}">${e.type === 'OUT' ? 'OUT' : 'IN '}</span> ${t}</span>`;
      const del = document.createElement('button');
      del.className = 'del'; del.textContent = '✕'; del.title = 'Delete';
      del.onclick = () => deleteEvent(e.id);
      li.appendChild(del);
      els.eventList.appendChild(li);
    }
  }

  async function addEvent() {
    const type = els.editType.value, val = els.editTime.value;
    if (!val) { els.editTime.focus(); return; }
    const at = new Date(val).getTime();
    const r = Core.applyEvent(loadLocalLog(), { type, at, src: 'manual', id: Core.makeId(at) }, Date.now());
    if (!r.applied) { els.actionHint.textContent = 'That would duplicate the current state.'; return; }
    saveLocalLog(r.log); render(localSnapshot());
    await persist();
  }

  async function deleteEvent(id) {
    saveLocalLog(loadLocalLog().filter(e => e.id !== id));
    render(localSnapshot());
    // Deletion can't merge-union (the point is removal), so write the local log directly.
    try { const saved = await store.appendLog(loadLocalLog()); saveLocalLog(saved.log); setOnline(true); }
    catch (_) { set(LS.queueDirty, '1'); setOnline(false); }
  }

  // ---- boot ----------------------------------------------------------------
  function boot() {
    // setup screen handlers
    els.setupCreate.addEventListener('click', doCreate);
    els.setupUseExisting.addEventListener('click', doUseExisting);

    // app handlers
    els.toggle.addEventListener('click', toggle);
    els.settingsBtn.addEventListener('click', () => {
      // re-open setup to change/replace credentials
      els.setupStatus.textContent = '';
      els.setupGistId.value = store.gistId || '';
      showSetup();
    });
    els.shortcutHelp.addEventListener('click', (e) => {
      e.preventDefault();
      alert('Voice + lock-screen reminders use two iOS Shortcuts named “Aligners Off” and “Aligners On”. Full setup recipe is in the project’s shortcuts/README. They read & write this same gist and create native reminders.');
    });
    els.editToggle.addEventListener('click', () => {
      const open = els.editPanel.hidden;
      els.editPanel.hidden = !open;
      if (open) {
        const n = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
        els.editTime.value = n.toISOString().slice(0, 16);
        renderEventList();
      }
    });
    els.editAdd.addEventListener('click', addEvent);

    window.addEventListener('online', () => { setOnline(true); refresh(); });
    window.addEventListener('offline', () => setOnline(false));
    document.addEventListener('visibilitychange', () => { if (!document.hidden && store.isConfigured()) refresh(); });

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(() => {});

    // route: configured -> app, else setup
    if (store.isConfigured()) { enterApp(); }
    else { showSetup(); }

    // periodic resync (picks up Siri-logged events + midnight reset);
    // only while the app screen is showing (setup hidden) and tab visible.
    setInterval(() => {
      if (!document.hidden && store.isConfigured() && setupEl.hidden) refresh();
    }, 60000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
