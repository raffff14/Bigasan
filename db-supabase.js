/* Bigasan Inventory — Supabase connection.
   The app was written against a small document-store API (collection/doc/where/orderBy/limit/
   get/set/update/delete/onSnapshot). This file provides that same API on top of one Supabase
   table (public.docs), adds the login screen, live updates, file downloads, offline notice,
   PWA install and the service worker. The app itself is unchanged apart from calling it. */
(function () {
  "use strict";
  const CFG = window.BIGASAN_CONFIG || {};
  const configured = /^https:\/\/\S+/.test(CFG.SUPABASE_URL || '') && !!CFG.SUPABASE_ANON_KEY && !/PASTE_/.test(CFG.SUPABASE_URL + CFG.SUPABASE_ANON_KEY);
  const OPS = { '==': 'eq', '!=': 'neq', '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte' };
  const META = { fromCache: false, hasPendingWrites: false };
  const clone = x => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const newDocId = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let sb = null, me = null;

  /* ---------- errors, in the shape the app expects ---------- */
  function mapErr(e) {
    const msg = (e && (e.message || e.error_description)) || String(e || 'Unknown error');
    if (e && (e.code === '42501' || /row-level security|permission denied/i.test(msg))) return { code: 'invalid_argument', message: msg };
    if (e && (e.code === 'PGRST301' || /JWT|not authenticated/i.test(msg))) return { code: 'revoked', message: msg };
    if (e && /^(22|23|42)/.test(e.code || '')) return { code: 'invalid_argument', message: msg };
    return { code: 'unavailable', message: msg };
  }

  /* ---------- snapshots ---------- */
  const docSnap = (id, data) => ({ id, exists: data != null, data: () => (data == null ? undefined : clone(data)), metadata: META });
  const querySnap = rows => { const docs = rows.map(r => docSnap(r.id, r.data)); return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: META }; };
  const txt = v => (v == null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
  function matches(spec, data) {
    return spec.F.every(([f, op, v]) => {
      const a = txt(data && data[f]); if (a == null) return false; const b = String(v);
      return op === '==' ? a === b : op === '!=' ? a !== b : op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : op === '>=' ? a >= b : false;
    });
  }
  function sortRows(spec, rows) {
    if (!spec.O) return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const [f, dir] = spec.O, s = dir === 'desc' ? -1 : 1;
    return rows.sort((a, b) => { const x = txt(a.data[f]), y = txt(b.data[f]); if (x == null) return 1; if (y == null) return -1; return (x < y ? -1 : x > y ? 1 : 0) * s; });
  }

  /* ---------- reads ---------- */
  async function runQuery(spec) {
    let r = sb.from('docs').select('id,data').eq('col', spec.col);
    for (const [f, op, v] of spec.F) {
      if (!OPS[op]) throw { code: 'invalid_argument', message: 'Unsupported filter ' + op };
      r = r[OPS[op]]('data->>' + f, v);
    }
    r = spec.O ? r.order('data->>' + spec.O[0], { ascending: spec.O[1] !== 'desc', nullsFirst: false }) : r.order('id', { ascending: true });
    r = r.limit(Math.min(spec.N || 1000, 1000));
    const { data, error } = await r;
    if (error) throw mapErr(error);
    online(true);
    return (data || []).map(x => ({ id: x.id, data: x.data }));
  }
  async function readDoc(col, id) {
    const { data, error } = await sb.from('docs').select('id,data').eq('col', col).eq('id', id).maybeSingle();
    if (error) throw mapErr(error);
    online(true);
    return data ? data.data : undefined;
  }

  /* ---------- live listeners ---------- */
  const listeners = new Set();
  function addListener(l) {
    listeners.add(l);
    l.refresh();
    return () => { l.alive = false; listeners.delete(l); };
  }
  function queryListener(spec, next, onErr) {
    const l = { spec, rows: null, alive: true, small: spec.col !== 'txns' };
    l.refresh = async () => {
      try { const rows = await runQuery(spec); if (l.alive) { l.rows = rows; next(querySnap(rows)); } }
      catch (e) { netFail(e, onErr, l); }
    };
    l.apply = ev => {
      if (!l.rows || ev.col !== spec.col) return;
      const i = l.rows.findIndex(r => r.id === ev.id);
      if (ev.type === 'DELETE') {
        if (i < 0) return;
        if (spec.N && l.rows.length >= spec.N) return l.refresh();
        l.rows.splice(i, 1);
      } else {
        const fits = matches(spec, ev.data);
        if (i >= 0) { if (fits) l.rows[i] = { id: ev.id, data: ev.data }; else { if (spec.N) return l.refresh(); l.rows.splice(i, 1); } }
        else if (fits) l.rows.push({ id: ev.id, data: ev.data });
        else return;
        sortRows(spec, l.rows);
        if (spec.N && l.rows.length > spec.N) l.rows.length = spec.N;
      }
      next(querySnap(l.rows.slice()));
    };
    return addListener(l);
  }
  function docListener(col, id, next, onErr) {
    const l = { spec: { col }, alive: true, small: true };
    l.refresh = async () => { try { const d = await readDoc(col, id); if (l.alive) next(docSnap(id, d)); } catch (e) { netFail(e, onErr, l); } };
    l.apply = ev => { if (ev.col === col && ev.id === id) next(docSnap(id, ev.type === 'DELETE' ? undefined : ev.data)); };
    return addListener(l);
  }
  function netFail(e, onErr, l) {
    if (e && e.code === 'unavailable') { online(false); setTimeout(() => { if (l.alive) l.refresh(); }, 5000); return; }
    l.alive = false; listeners.delete(l);
    if (onErr) onErr(e); else console.error(e);
  }
  function dispatch(ev) { listeners.forEach(l => { if (l.alive) l.apply(ev); }); }
  function refreshAll(onlySmall) { listeners.forEach(l => { if (l.alive && (!onlySmall || l.small)) l.refresh(); }); }

  let rtOk = false, pollTimer = 0;
  function startRealtime() {
    sb.channel('bigasan-docs')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, p => {
        const row = p.new && p.new.col ? p.new : p.old || {};
        dispatch({ type: p.eventType === 'DELETE' ? 'DELETE' : 'UPSERT', col: row.col, id: row.id, data: p.new && p.new.data });
      })
      .subscribe(status => {
        const was = rtOk; rtOk = status === 'SUBSCRIBED';
        if (rtOk && !was) refreshAll(false);   // catch up on anything missed while disconnected
        schedulePoll();
      });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshAll(false); });
    window.addEventListener('online', () => { online(true); refreshAll(false); });
    window.addEventListener('offline', () => online(false));
  }
  // safety net: every 15 s while live updates are down, every 5 min otherwise (small lists only)
  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { if (document.visibilityState === 'visible') refreshAll(rtOk); schedulePoll(); }, rtOk ? 300000 : 15000);
  }

  /* ---------- writes ---------- */
  async function upsert(col, id, data) {
    const { error } = await sb.from('docs').upsert({ col, id, data, updated_at: new Date().toISOString() }, { onConflict: 'col,id' });
    if (error) throw mapErr(error);
    online(true);
    dispatch({ type: 'UPSERT', col, id, data: clone(data) });
  }
  function merge(base, patch) {
    const out = Object.assign({}, base);
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v;
    }
    return out;
  }
  function docRef(col, id) {
    return {
      id, path: col + '/' + id,
      get: async () => docSnap(id, await readDoc(col, id)),
      set: async data => upsert(col, id, clone(data)),
      update: async patch => {
        const cur = await readDoc(col, id);
        if (cur == null) throw { code: 'invalid_argument', message: 'Document does not exist' };
        return upsert(col, id, merge(cur, clone(patch)));
      },
      delete: async () => {
        const { error } = await sb.from('docs').delete().eq('col', col).eq('id', id);
        if (error) throw mapErr(error);
        dispatch({ type: 'DELETE', col, id });
      },
      acquire: async () => ({ acquired: true }),
      onSnapshot: (next, onErr) => docListener(col, id, next, onErr)
    };
  }
  function query(spec) {
    return {
      path: spec.col,
      where: (f, op, v) => query(Object.assign({}, spec, { F: spec.F.concat([[f, op, v]]) })),
      orderBy: (f, dir) => query(Object.assign({}, spec, { O: [f, dir || 'asc'] })),
      limit: n => query(Object.assign({}, spec, { N: n })),
      get: async () => querySnap(await runQuery(spec)),
      onSnapshot: (next, onErr) => queryListener(spec, next, onErr),
      doc: id => docRef(spec.col, id || newDocId()),
      add: async data => { const r = docRef(spec.col, newDocId()); await r.set(data); return r; }
    };
  }
  const db = Object.freeze({
    collection: name => query({ col: String(name), F: [], O: null, N: null }),
    doc: path => { const [col, id] = String(path).split('/'); return docRef(col, id); },
    /* stock changes run inside Postgres (commit_txn) so the check and the write happen together */
    commitTxn: async (productId, moves, fields) => {
      const txnId = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const { data, error } = await sb.rpc('commit_txn', { p_product: productId, p_txn_id: txnId, p_moves: moves, p_fields: fields });
      if (error) {
        const m = /INSUFFICIENT:(\w+):(-?[\d.]+)/.exec(error.message || '');
        if (m) throw { code: 'insufficient', loc: m[1], avail: +m[2], message: error.message };
        if (/NOCHANGE/.test(error.message || '')) throw { code: 'nochange', message: error.message };
        throw mapErr(error);
      }
      online(true);
      dispatch({ type: 'UPSERT', col: 'txns', id: txnId, data: data.txn });
      dispatch({ type: 'UPSERT', col: 'stock', id: productId, data: data.stock });
      return Object.assign({ id: txnId }, data.txn);
    }
  });

  /* ---------- receipt photos (Supabase Storage, private bucket "receipts") ---------- */
  const urlCache = {};
  const storageErr = e => /bucket not found/i.test((e && e.message) || '') ? { code: 'no_bucket', message: e.message } : mapErr(e);
  const files = Object.freeze({
    upload: async (path, blob) => {
      const { error } = await sb.storage.from('receipts').upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false });
      if (error) throw storageErr(error);
      online(true); return path;
    },
    url: async path => {
      const c = urlCache[path]; if (c && c.exp > Date.now()) return c.url;
      const { data, error } = await sb.storage.from('receipts').createSignedUrl(path, 3600);
      if (error) throw storageErr(error);
      urlCache[path] = { url: data.signedUrl, exp: Date.now() + 3300 * 1000 };
      return data.signedUrl;
    },
    remove: async path => {
      const { error } = await sb.storage.from('receipts').remove([path]);
      if (error) throw storageErr(error);
      delete urlCache[path];
    }
  });

  /* ---------- who is signed in ---------- */
  const user = Object.freeze({
    id: async () => (me ? me.id : null),
    can: async () => true,
    canEdit: async () => true,
    isOwner: async () => true,
    me: async () => ({ id: me ? me.id : null, name: me ? me.email || '' : '', email: me ? me.email : null, isOwner: true, canEdit: true }),
    profiles: async ids => Object.fromEntries([].concat(ids).map(i => [i, { id: i, name: me && i === me.id ? (me.email || '').split('@')[0] : '', isMe: !!me && i === me.id }]))
  });

  /* ---------- downloads (CSV / backup) ---------- */
  const TYPES = { csv: 'text/csv;charset=utf-8', json: 'application/json', txt: 'text/plain' };
  const downloads = Object.freeze({
    save: async ({ filename, data }) => {
      const ext = String(filename).split('.').pop().toLowerCase();
      const blob = data instanceof Blob ? data : new Blob([data], { type: TYPES[ext] || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      return { status: 'saved' };
    }
  });

  /* ---------- screens shown before the app: setup needed / sign in ---------- */
  function overlay(html) {
    const el = document.createElement('div');
    el.className = 'gate';
    el.innerHTML = `<div class="gate-card"><div class="brand"><div class="brand-mark" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3h8l-1.2 3.2A7 7 0 0 1 19 12.5V17a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4v-4.5a7 7 0 0 1 4.2-6.3z"/><path d="M9 6.5h6"/></svg></div><div><div class="brand-name">Bigasan Inventory</div><div class="brand-sub">Stall &amp; Bodega stock</div></div></div>${html}</div>`;
    document.body.appendChild(el);
    return el;
  }
  function showSetupNeeded() {
    overlay(`<h2>Almost ready</h2><p>Open <b>config.js</b> and paste your Supabase Project URL and anon key, then upload the files again.</p><p class="muted small">See SETUP.md, step 2.</p>`);
  }
  function showLogin() {
    return new Promise(resolve => {
      const el = overlay(`<h2>Sign in</h2><form class="form" id="gate-f" novalidate>
        <div class="field"><label for="gate-email">Email</label><input type="email" id="gate-email" autocomplete="username" inputmode="email" required></div>
        <div class="field"><label for="gate-pass">Password</label><input type="password" id="gate-pass" autocomplete="current-password" required></div>
        <div class="form-err" id="gate-err" role="alert"></div>
        <button class="btn primary big block" id="gate-go">Sign in</button></form>
        <p class="muted small">You stay signed in on this device.</p>`);
      const f = el.querySelector('#gate-f');
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const err = el.querySelector('#gate-err'), btn = el.querySelector('#gate-go');
        err.textContent = ''; btn.disabled = true; btn.textContent = 'Signing in…';
        const { data, error } = await sb.auth.signInWithPassword({ email: el.querySelector('#gate-email').value.trim(), password: el.querySelector('#gate-pass').value });
        if (error || !data.session) {
          err.textContent = /fetch|network/i.test(error && error.message || '') ? 'No internet connection. Connect and try again.' : 'Wrong email or password.';
          btn.disabled = false; btn.textContent = 'Sign in'; return;
        }
        el.remove(); resolve(data.session);
      });
      setTimeout(() => { const i = el.querySelector('#gate-email'); if (i) i.focus(); }, 50);
    });
  }

  /* ---------- offline notice ---------- */
  let offlineEl = null;
  function online(ok) {
    if (ok && navigator.onLine !== false) { if (offlineEl) { offlineEl.remove(); offlineEl = null; } return; }
    if (offlineEl) return;
    offlineEl = document.createElement('div');
    offlineEl.className = 'offline-bar'; offlineEl.setAttribute('role', 'status');
    offlineEl.textContent = 'No internet. Stock shown may be out of date, and nothing can be saved until you reconnect.';
    document.body.appendChild(offlineEl);
  }

  /* ---------- install as an app + service worker ---------- */
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; window.dispatchEvent(new Event('bigasan:installable')); });
  window.addEventListener('appinstalled', () => { installEvt = null; window.dispatchEvent(new Event('bigasan:installable')); });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
  window.bigasanApp = {
    get email() { return me ? me.email : ''; },
    get canInstall() { return !!installEvt; },
    get installed() { return window.matchMedia('(display-mode: standalone)').matches; },
    install: async () => { if (!installEvt) return false; installEvt.prompt(); const r = await installEvt.userChoice; installEvt = null; window.dispatchEvent(new Event('bigasan:installable')); return r && r.outcome === 'accepted'; },
    signOut: async () => { try { await sb.auth.signOut(); } catch (e) {} location.reload(); }
  };

  /* ---------- start ---------- */
  const ready = (async () => {
    if (!configured || !window.supabase) { showSetupNeeded(); return false; }
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    let session = null;
    try { session = (await sb.auth.getSession()).data.session; } catch (e) {}
    if (!session) session = await showLogin();
    me = session.user;
    sb.auth.onAuthStateChange((evt, s) => { if (evt === 'SIGNED_OUT') location.reload(); else if (s) me = s.user; });
    startRealtime();
    return true;
  })();
  window.claude = Object.freeze({
    use: async name => {
      if (!(await ready)) return null;
      return name === 'db' ? db : name === 'user' ? user : name === 'downloads' ? downloads : name === 'files' ? files : null;
    }
  });
})();
