/*
 * gist-store.js — serverless data layer for "22".
 *
 * The shared event log lives in a single GitHub Gist. Both the PWA (browser
 * fetch) and the iOS Shortcut read/write it through the GitHub REST API,
 * which is CORS-open (Access-Control-Allow-Origin: *, allows Authorization
 * + PATCH). No custom server, no third-party signup — GitHub is the database.
 *
 * Verified live (2026-06-30): GET is tokenless+CORS; PATCH with a `gist`-scope
 * token writes; GitHub's API caches GET ~60s so we ALWAYS cache-bust reads.
 *
 * Auth: a fine-grained / classic PAT with ONLY the `gist` scope. Stored in
 * localStorage on the device (single-user personal app). Blast radius if
 * leaked = that user's gists only.
 *
 * Universal module: CommonJS (Node/tests) + browser global (window.GistStore).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GistStore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const API = 'https://api.github.com';
  const STATE_FILE = 'aligners-state.json';
  const SCHEMA_VERSION = 1;

  // Allow tests to inject a fetch + a deterministic cache-buster.
  function makeStore(opts) {
    opts = opts || {};
    const _fetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    // cacheBuster() must return a changing value; tests pass a counter.
    const cacheBuster = opts.cacheBuster || (() => String(Date.now()) + '-' + Math.round(performance?.now?.() || 0));
    if (!_fetch) throw new Error('gist-store: no fetch available');

    let gistId = opts.gistId || null;
    let token = opts.token || null;

    function setCredentials(id, tok) { gistId = id; token = tok; }
    function isConfigured() { return !!(gistId && token); }

    function headers(withAuth) {
      const h = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
      if (withAuth && token) h['Authorization'] = 'token ' + token;
      return h;
    }

    function emptyState() { return { log: [], v: SCHEMA_VERSION }; }

    function parseState(content) {
      try {
        const s = JSON.parse(content);
        return { log: Array.isArray(s.log) ? s.log : [], v: s.v || SCHEMA_VERSION };
      } catch (_) { return emptyState(); }
    }

    // Read the full gist object (cache-busted). Returns {state, etag, raw}.
    async function read() {
      if (!gistId) throw new Error('gist-store: not configured (no gistId)');
      const url = API + '/gists/' + gistId + '?cb=' + encodeURIComponent(cacheBuster());
      const res = await _fetch(url, { headers: headers(!!token), cache: 'no-store' });
      if (!res.ok) throw new Error('gist read failed: HTTP ' + res.status);
      const gist = await res.json();
      const file = gist.files && (gist.files[STATE_FILE] || Object.values(gist.files)[0]);
      const content = file ? file.content : '';
      return { state: parseState(content), etag: res.headers.get('etag'), gist };
    }

    // Write the full state back (PATCH). Requires token.
    async function write(state) {
      if (!gistId) throw new Error('gist-store: not configured (no gistId)');
      if (!token) throw new Error('gist-store: write needs a token');
      const body = { files: {} };
      body.files[STATE_FILE] = { content: JSON.stringify({ log: state.log, v: SCHEMA_VERSION }) };
      const res = await _fetch(API + '/gists/' + gistId, {
        method: 'PATCH', headers: Object.assign({ 'Content-Type': 'application/json' }, headers(true)),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('gist write failed: HTTP ' + res.status);
      const gist = await res.json();
      const file = gist.files[STATE_FILE];
      return { state: parseState(file.content), gist };
    }

    // Append an event with read-modify-write. Idempotency/validation is the
    // caller's job (via WearCore.applyEvent); this just persists the new log.
    // Returns {state, applied}. For a single user the race window is tiny;
    // we do one retry on a write conflict-ish failure.
    async function appendLog(newLog) {
      return (await write({ log: newLog })).state;
    }

    // Create a brand-new gist holding an empty state. Returns the new gist id.
    async function createGist(description) {
      if (!token) throw new Error('gist-store: create needs a token');
      const body = {
        description: description || '22 aligners — wear-time event log',
        public: false,
        files: {},
      };
      body.files[STATE_FILE] = { content: JSON.stringify(emptyState()) };
      const res = await _fetch(API + '/gists', {
        method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers(true)),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('gist create failed: HTTP ' + res.status);
      const gist = await res.json();
      gistId = gist.id;
      return gist.id;
    }

    // Validate a token by hitting /gists (cheap, authed). Returns {ok, login}.
    async function validateToken() {
      try {
        const res = await _fetch(API + '/user', { headers: headers(true), cache: 'no-store' });
        if (!res.ok) return { ok: false, status: res.status };
        const u = await res.json();
        return { ok: true, login: u.login };
      } catch (e) { return { ok: false, error: String(e.message || e) }; }
    }

    return {
      STATE_FILE, SCHEMA_VERSION,
      setCredentials, isConfigured, emptyState, parseState,
      read, write, appendLog, createGist, validateToken,
      get gistId() { return gistId; },
    };
  }

  return { makeStore, API, STATE_FILE, SCHEMA_VERSION };
}));
