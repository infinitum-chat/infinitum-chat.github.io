/* PocketBase-kant van de database-laag (stap 9).
   Dit bestand bootst het deel van de Firestore-API na dat Infinitum gebruikt (collection, doc, getDoc, setDoc, updateDoc, onSnapshot, writeBatch, ...) en praat
   daarachter met PocketBase. Alle verschillen tussen de twee databases (veldnamen, id's, batches die op de server een route zijn, realtime) staan hier, in
   één tabel (ADAPTERS) en een paar functies, zodat app.js zelf bijna niet verandert. js/db.js kiest per sessie Firestore of PocketBase.
   Dit bestand importeert niets van buiten, zodat het ook in Node getest kan worden (tests/run-tests.js). */

export function createPB(env) {
  const { url: BASE, fetch: _fetch, EventSource: ES, sha256hex, now = () => Date.now(), pollMs = 20000, random } = env;

  /* ================= basis: foutmeldingen, tijd, speciale waarden ================= */
  class PBError extends Error {
    constructor(status, message, code, data) { super(message); this.name = 'PBError'; this.status = status; this.code = code; this.data = data; this.pb = true; }
  }
  const CODES = { 400: 'invalid-argument', 401: 'unauthenticated', 403: 'permission-denied', 404: 'not-found', 429: 'resource-exhausted' };
  const unsupported = (what) => new PBError(0, 'Dit werkt nog niet in de PocketBase-modus (' + what + ').', 'unimplemented');

  class Timestamp {
    constructor(seconds, nanoseconds) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
    static fromMillis(ms) { const s = Math.floor(ms / 1000); return new Timestamp(s, Math.floor((ms - s * 1000) * 1e6)); }
    static fromDate(d) { return Timestamp.fromMillis(d.getTime()); }
    static now() { return Timestamp.fromMillis(now()); }
    toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
    toDate() { return new Date(this.toMillis()); }
    isEqual(o) { return !!o && o.seconds === this.seconds && o.nanoseconds === this.nanoseconds; }
    toJSON() { return { seconds: this.seconds, nanoseconds: this.nanoseconds }; }
  }
  const FV = (t, extra) => Object.assign({ __fv: t }, extra || {});
  const serverTimestamp = () => FV('ts');
  const deleteField = () => FV('del');
  const arrayUnion = (...els) => FV('union', { els });
  const arrayRemove = (...els) => FV('remove', { els });
  const isFV = (v, t) => !!v && typeof v === 'object' && v.__fv === (t || v.__fv) && typeof v.__fv === 'string';
  const isTs = (v) => v instanceof Timestamp;
  const pbDate = (ms) => new Date(ms).toISOString().replace('T', ' ');
  const parseDate = (s) => { const ms = Date.parse(String(s).replace(' ', 'T')); return isNaN(ms) ? null : ms; };
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const autoId = () => { let s = ''; for (let i = 0; i < 20; i++) s += ID_CHARS[Math.floor((random ? random() : Math.random()) * 62)]; return s; };

  /* ================= verwijzingen (refs) ================= */
  class Ref {
    constructor(kind, segs) { this.__pb = true; this.kind = kind; this.segs = segs; this.type = kind === 'doc' ? 'document' : 'collection'; }
    get id() { return this.segs[this.segs.length - 1]; }
    get path() { return this.segs.join('/'); }
    get parent() { return this.kind === 'col' ? (this.segs.length > 1 ? new Ref('doc', this.segs.slice(0, -1)) : null) : new Ref('col', this.segs.slice(0, -1)); }
  }
  const flat = (parts) => parts.flatMap((p) => String(p).split('/')).filter((x) => x !== '');
  function collection(base, ...rest) {
    const segs = base instanceof Ref ? base.segs.concat(flat(rest)) : flat(rest);
    if (segs.length % 2 !== 1) throw new Error('Ongeldig collectiepad: ' + segs.join('/'));
    return new Ref('col', segs);
  }
  function doc(base, ...rest) {
    if (base instanceof Ref && base.kind === 'col') { const id = rest.length ? flat(rest) : [autoId()]; return new Ref('doc', base.segs.concat(id)); }
    const segs = base instanceof Ref ? base.segs.concat(flat(rest)) : flat(rest);
    if (segs.length % 2 !== 0) throw new Error('Ongeldig documentpad: ' + segs.join('/'));
    return new Ref('doc', segs);
  }
  const where = (field, op, value) => ({ t: 'where', field, op, value });
  const orderBy = (field, dir) => ({ t: 'order', field, dir: dir === 'desc' ? 'desc' : 'asc' });
  const limit = (n) => ({ t: 'limit', n });
  function query(col, ...cons) { const base = col.kind === 'query' ? col.cons : []; return { __pb: true, kind: 'query', col: col.kind === 'query' ? col.col : col, cons: base.concat(cons.flat()) }; }
  const specOf = (q) => {
    const c = q.kind === 'query' ? q.cons : [];
    return { col: q.kind === 'query' ? q.col : q, wheres: c.filter((x) => x.t === 'where'), orders: c.filter((x) => x.t === 'order'), limit: (c.find((x) => x.t === 'limit') || {}).n || 0 };
  };

  /* ================= snapshots ================= */
  class DocSnap {
    constructor(ref, data) { this.ref = ref; this.id = ref.id; this._d = data; this.metadata = { hasPendingWrites: false, fromCache: false }; }
    exists() { return this._d !== null && this._d !== undefined; }
    data() { return this.exists() ? clone2(this._d) : undefined; }
    get(f) { return this.exists() ? this._d[f] : undefined; }
  }
  class QuerySnap {
    constructor(docs, changes) { this.docs = docs; this._ch = changes; this.size = docs.length; this.empty = docs.length === 0; this.metadata = { hasPendingWrites: false, fromCache: false }; }
    forEach(fn) { this.docs.forEach(fn); }
    docChanges() { return this._ch; }
  }
  // kopie van een document, met Timestamps die Timestamps blijven
  function clone2(v) {
    if (v === null || typeof v !== 'object') return v;
    if (isTs(v)) return new Timestamp(v.seconds, v.nanoseconds);
    if (Array.isArray(v)) return v.map(clone2);
    const o = {}; for (const k of Object.keys(v)) o[k] = clone2(v[k]); return o;
  }

  /* ================= de tabel: welk Firestore-pad hoort bij welke PocketBase-collectie ================= */
  // pat = het collectiepad (met * voor een id); pb = collectie; scope(S) = velden die het pad vastlegt (de relatie); idOf(S, fid) = PocketBase-id; fid(rec) = het Firestore-id;
  // ts = datumvelden (Timestamp in de app); srv = velden die de server zelf zet (niet meesturen); rename = veldnaam in Firestore -> in PocketBase;
  // json = velden die als geheel worden verstuurd (puntpaden doen we lezen-aanpassen-schrijven); rel = relatieveld met `+`/`-`; cq = array-contains;
  // set = 'patch' (eerst wijzigen, bestaat het niet: aanmaken) of 'create' (eerst aanmaken, bestaat het al: wijzigen); poll = lijst alleen via een route;
  // serverId = laat de server het id kiezen; react = reageren via de route; to/from = laatste aanpassing van de gegevens.
  const chanOf = (S) => S[1] + '_' + (S.length >= 4 ? S[3] : 'general');
  const chanScope = (S) => ({ chan: chanOf(S), server: S[1] });
  const msgAd = (pat, scope, extra) => Object.assign({ pat, pb: 'x', scope, ts: ['createdAt', 'editedAt'], srv: ['createdAt', 'editedAt'], react: true }, extra);
  const stateAd = (pat, pb, scope, key) => ({ pat, pb, scope, idOf: (S, fid) => (key === 'chat' ? S[1] : chanOf(S)) + '_' + fid, fid: (r) => r.uid, ts: ['at'], srv: ['at'], body: (S, fid) => ({ uid: fid }) });
  const usersPair = {
    rename: {}, to: (b) => { if (Array.isArray(b.users)) { b.userA = b.users[0]; b.userB = b.users[1]; delete b.users; } },
    from: (d) => { d.users = [d.userA, d.userB]; delete d.userA; delete d.userB; },
    cq: { users: (v) => '(userA = ' + q(v) + ' || userB = ' + q(v) + ')' },
  };
  const ADAPTERS = [
    // een punt in een gebruikersnaam kan niet in een PocketBase-id: daar wordt het een streepje (een streepje is in een naam zelf niet toegestaan, dus omkeerbaar)
    { pat: 'usernames', pb: 'usernames', set: 'create', noOverwrite: true, idOf: (S, fid) => String(fid).replace(/\./g, '-'), fid: (r) => String(r.id).replace(/-/g, '.') },
    { pat: 'users', pb: 'users', ts: ['usernameChangedAt', 'createdAt'], srv: ['usernameChangedAt', 'createdAt'],
      from: (d) => { if (!d.tier) d.tier = 'free'; }, to: (b) => { if (b.tier === 'free') b.tier = ''; } },
    { pat: 'settings', pb: 'settings' },
    { pat: 'presenceSettings', pb: 'presenceSettings' },
    { pat: 'readState', pb: 'readState' },
    { pat: 'sparks', pb: 'sparks', ts: ['last_online_at'], srv: ['last_online_at'] },
    { pat: 'liveness', pb: 'liveness', ts: ['pcAt', 'phAt'] },
    { pat: 'presence', pb: 'presence', ts: ['lastSeen'], srv: ['lastSeen'] },
    { pat: 'config', pb: 'config', ts: ['updatedAt'], srv: ['updatedAt', 'by'],
      from: (d, r) => { if (r.id === 'features' || r.id === 'plans' || r.id === 'sparks') { const x = d.data && typeof d.data === 'object' ? d.data : {}; for (const k of Object.keys(d)) delete d[k]; Object.assign(d, x); } },
      to: (b, S, fid) => { if (fid === 'features' || fid === 'plans' || fid === 'sparks') { const x = Object.assign({}, b); for (const k of Object.keys(b)) delete b[k]; b.data = x; } } },
    { pat: 'features', pb: 'features' },
    { pat: 'badges', pb: 'badges' },
    { pat: 'legal', pb: 'legal', ts: ['updatedAt'], srv: ['updatedAt', 'by'] },
    { pat: 'blocks', pb: 'blocks', ts: ['createdAt'], srv: ['createdAt'], set: 'create', noOverwrite: true },
    { pat: 'notifications', pb: 'notifications', ts: ['createdAt'], srv: ['createdAt'], serverId: true },
    { pat: 'friendships', pb: 'friendships', ts: ['createdAt'], srv: ['createdAt'], set: 'create', to: usersPair.to, from: usersPair.from, cq: usersPair.cq },
    { pat: 'subscriptions', pb: 'subscriptions', ts: ['requestedAt', 'decidedAt'], srv: ['requestedAt', 'decidedAt'],
      from: (d) => { if (d.votes && typeof d.votes === 'object') for (const k of Object.keys(d.votes)) if (typeof d.votes[k].at === 'number') d.votes[k].at = Timestamp.fromMillis(d.votes[k].at); },
      poll: { route: '/api/sub-admin', key: (sp) => (sp.wheres.some((w) => w.field === 'status' && w.op === '==') ? 'pending' : 'done') } },
    { pat: 'moderation', pb: 'moderation', ts: ['timeoutAt', 'updatedAt'], srv: ['timeoutAt', 'updatedAt'],
      from: (d) => { if (d.last && typeof d.last.at === 'number') d.last.at = Timestamp.fromMillis(d.last.at); },
      poll: { route: '/api/mod-admin', key: () => 'moderation' } },
    { pat: 'modLog', pb: 'modLog', ts: ['at'], srv: ['at'], serverId: true, poll: { route: '/api/mod-admin', key: () => 'modLog' } },
    { pat: 'spamLocks', pb: 'spamLocks', ts: ['at'], srv: ['at'], poll: { route: '/api/mod-admin', key: () => 'spamLocks' } },
    { pat: 'spamLog', pb: 'spamLog', ts: ['at'], srv: ['at'], serverId: true, poll: { route: '/api/mod-admin', key: () => 'spamLog' } },
    { pat: 'reports', pb: 'reports', ts: ['createdAt', 'handledAt', 'updatedAt'], srv: ['createdAt', 'handledAt', 'updatedAt'], set: 'create',
      poll: { route: '/api/reports-admin', key: (sp) => (sp.wheres.some((w) => w.field === 'status') ? 'active' : 'done') } },
    { pat: 'reports/*/notes', pb: 'reportNotes', scope: (S) => ({ report: S[1] }), ts: ['createdAt'], srv: ['createdAt'], serverId: true,
      poll: { route: (S) => '/api/report-notes?id=' + encodeURIComponent(S[1]), key: () => 'items' } },
    { pat: 'chats', pb: 'chats', ts: ['lastAt'], srv: ['lastAt'] },
    msgAd('chats/*/messages', (S) => ({ chat: S[1] }), { pb: 'dmMessages', clientId: true }),
    stateAd('chats/*/typing', 'dmTyping', (S) => ({ chat: S[1] }), 'chat'),
    stateAd('chats/*/reads', 'dmReads', (S) => ({ chat: S[1] }), 'chat'),
    { pat: 'servers', pb: 'servers', ts: ['createdAt'], srv: ['createdAt'], json: ['roles', 'permIdx', 'mroles'], rel: ['members'],
      cq: { members: (v) => 'memberKeys ~ ' + q(v) }, from: (d) => { delete d.memberKeys; }, to: (b) => { delete b.memberKeys; } },
    { pat: 'servers/*/channels', pb: 'channels', scope: (S) => ({ server: S[1] }), idOf: (S, fid) => S[1] + '_' + fid, fid: (r) => r.cid, ts: ['createdAt'], srv: ['createdAt'], json: ['acl'],
      delDefault: { notifyAll: false, showAuthor: true, userLimit: 0 }, body: (S, fid) => ({ cid: fid }),
      from: (d) => { delete d.viewAll; delete d.readKeys; delete d.server; delete d.cid; } },
    msgAd('servers/*/messages', chanScope, { pb: 'channelMessages', clientId: true, from: (d) => { delete d.server; delete d.chan; } }),
    msgAd('servers/*/channels/*/messages', chanScope, { pb: 'channelMessages', clientId: true, from: (d) => { delete d.server; delete d.chan; } }),
    Object.assign(stateAd('servers/*/typing', 'channelTyping', chanScope, 'chan'), { from: (d) => { delete d.server; delete d.chan; } }),
    Object.assign(stateAd('servers/*/reads', 'channelReads', chanScope, 'chan'), { from: (d) => { delete d.server; delete d.chan; } }),
    Object.assign(stateAd('servers/*/channels/*/typing', 'channelTyping', chanScope, 'chan'), { from: (d) => { delete d.server; delete d.chan; } }),
    Object.assign(stateAd('servers/*/channels/*/reads', 'channelReads', chanScope, 'chan'), { from: (d) => { delete d.server; delete d.chan; } }),
    Object.assign(stateAd('servers/*/channels/*/voice', 'voice', chanScope, 'chan'), { from: (d) => { delete d.server; delete d.chan; } }),
    { pat: 'servers/*/channels/*/sigs', pb: 'sigs', scope: chanScope, idOf: (S, fid) => chanOf(S) + '_' + fid, fid: (r) => r.fromUid + '_' + r.toUid,
      rename: { from: 'fromUid', to: 'toUid' }, ts: ['createdAt'], srv: ['createdAt'], from: (d) => { delete d.server; delete d.chan; } },
    { pat: 'calls', pb: 'calls', ts: ['createdAt'], srv: ['createdAt'] },
    { pat: 'snaps', pb: 'snaps', rename: { from: 'fromUid', to: 'toUid' }, ts: ['createdAt', 'openedAt'], srv: ['createdAt'], clientId: true },
    Object.assign({ pat: 'streaks', pb: 'streaks', ts: ['incAt', 'updatedAt'], srv: ['incAt', 'updatedAt'] }, { to: usersPair.to, from: usersPair.from, cq: usersPair.cq }),
    { pat: 'streakUsers', pb: 'streakUsers' },
    { pat: 'pushTokens', pb: 'pushTokens', ts: ['updatedAt'], srv: ['updatedAt'], idOf: async (S, fid) => sha256hex(fid), fid: (r) => r.token, body: (S, fid) => ({ token: fid }), set: 'create' },
    { pat: 'pushTests', pb: 'pushTests', ts: ['at'], srv: ['at'] },
    { pat: 'sessions/*/devices', pb: 'devices', scope: (S) => ({ uid: S[1] }), idOf: (S, fid) => S[1] + '_' + fid, fid: (r) => r.did, ts: ['createdAt', 'lastActive'], srv: ['createdAt', 'lastActive'],
      body: (S, fid) => ({ did: fid }) },
  ];
  const BY_PAT = new Map(ADAPTERS.map((a) => [a.pat, a]));
  // Firestore-veldnamen die in PocketBase anders heten (voor de filter en het sorteren)
  const pbField = (ad, f) => (ad.rename && ad.rename[f]) || f;
  const q = (v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

  function resolveCol(ref) {
    const segs = ref.kind === 'doc' ? ref.segs.slice(0, -1) : ref.segs;
    const pat = segs.map((s, i) => (i % 2 === 0 ? s : '*')).join('/');
    const ad = BY_PAT.get(pat);
    if (!ad) throw unsupported('onbekend pad ' + segs.join('/'));
    return { ad, S: segs };
  }
  async function resolveDoc(ref) {
    const { ad, S } = resolveCol(ref); const fid = ref.id;
    return { ad, S, fid, pbId: ad.idOf ? await ad.idOf(S, fid) : fid };
  }

  /* ================= vertalen: PocketBase-record <-> Firestore-document ================= */
  function fromPB(ad, S, rec) {
    const d = {};
    for (const k of Object.keys(rec)) if (k !== 'collectionId' && k !== 'collectionName' && k !== 'expand' && k !== 'id') d[k] = clone(rec[k]);
    for (const [fsName, pbName] of Object.entries(ad.rename || {})) if (pbName in d) { d[fsName] = d[pbName]; delete d[pbName]; }
    for (const k of ad.ts || []) {
      if (typeof d[k] === 'string' && d[k] !== '') { const ms = parseDate(d[k]); if (ms === null) delete d[k]; else d[k] = Timestamp.fromMillis(ms); } else delete d[k];
    }
    if (ad.scope) { const sc = ad.scope(S); for (const k of Object.keys(sc)) delete d[k]; }
    if (ad.from) ad.from(d, rec);
    return d;
  }
  // nested: een tijdstempel in een kaart (zoals votes[uid].at) is in PocketBase een getal in milliseconden
  function nestedValue(v) {
    if (isFV(v, 'ts')) return now();
    if (isTs(v)) return v.toMillis();
    if (v instanceof Date) return v.getTime();
    if (Array.isArray(v)) return v.map(nestedValue);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = nestedValue(v[k]); return o; }
    return v;
  }
  // de gegevens van een document -> body voor PocketBase. mode: 'create' of 'update'
  function toBody(ad, S, fid, data, mode) {
    const b = {};
    for (const k of Object.keys(data)) {
      let v = data[k];
      if (v === undefined) continue;
      if ((ad.srv || []).indexOf(k) >= 0) continue;                        // de server zet dit zelf (ook als de app een gewone waarde meestuurt)
      const isTop = (ad.ts || []).indexOf(k) >= 0;
      if (isFV(v, 'ts') || isTs(v) || v instanceof Date) {
        if ((ad.srv || []).indexOf(k) >= 0) continue;                      // de server zet dit
        v = isFV(v, 'ts') ? pbDate(now()) : isTs(v) ? pbDate(v.toMillis()) : pbDate(v.getTime());
      } else if (isFV(v, 'del')) {
        v = ad.delDefault && k in ad.delDefault ? ad.delDefault[k] : null;
      } else if (isFV(v, 'union') || isFV(v, 'remove')) {
        if (!(ad.rel || []).includes(k)) throw unsupported('arrayUnion/arrayRemove op ' + k);
        b[k + (v.__fv === 'union' ? '+' : '-')] = v.els.length === 1 ? v.els[0] : v.els;
        continue;
      } else if (v !== null && typeof v === 'object') {
        v = nestedValue(v);
      }
      if (isTop && v === null) v = '';
      b[(ad.rename && ad.rename[k]) || k] = v;
    }
    if (ad.to) ad.to(b, S, fid);
    return b;
  }

  /* ================= verbinding met PocketBase ================= */
  let token = '', idTokenFn = null, loginPromise = null;
  async function rawFetch(method, path, body, retried) {
    let res;
    try {
      res = await _fetch(BASE + path, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: token } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) { throw new PBError(0, 'Geen verbinding met de database.', 'unavailable'); }
    let j = null; try { j = await res.json(); } catch (_) { j = null; }
    if (res.status === 401 && idTokenFn && !retried && path !== '/api/fb-login') { await relogin(); return rawFetch(method, path, body, true); }
    if (res.status >= 200 && res.status < 300) return j;
    let msg = (j && j.message) || 'Er ging iets mis (' + res.status + ').';
    if (j && j.data) for (const k of Object.keys(j.data)) if (j.data[k] && j.data[k].message) msg += ' ' + k + ': ' + j.data[k].message;
    throw new PBError(res.status, msg, CODES[res.status] || 'unknown', j && j.data);
  }
  async function relogin() {
    if (!loginPromise) loginPromise = (async () => {
      const idToken = await idTokenFn(true);
      const r = await rawFetch('POST', '/api/fb-login', { idToken }, true);
      token = r.token; RT.pushSubs();
    })().finally(() => { loginPromise = null; });
    return loginPromise;
  }
  async function login(getIdToken) { idTokenFn = getIdToken; token = ''; await relogin(); }
  function logout() { token = ''; idTokenFn = null; RT.close(); }
  const rec = (pb, id) => '/api/collections/' + pb + '/records/' + encodeURIComponent(id);

  async function pbGet(ad, id) {
    try { return await rawFetch('GET', rec(ad.pb, id)); } catch (e) { if (e.status === 404) return null; throw e; }
  }
  async function pbList(ad, { filter, sort, max }) {
    const out = []; let page = 1;
    for (;;) {
      const per = max ? Math.min(max, 200) : 200;
      const p = '?page=' + page + '&perPage=' + per + '&skipTotal=1' + (filter ? '&filter=' + encodeURIComponent(filter) : '') + (sort ? '&sort=' + encodeURIComponent(sort) : '');
      const r = await rawFetch('GET', '/api/collections/' + ad.pb + '/records' + p);
      const items = (r && r.items) || [];
      out.push(...items);
      if (max && out.length >= max) return out.slice(0, max);
      if (items.length < per) return out;
      page++;
    }
  }

  /* ================= realtime (SSE) ================= */
  const RT = {
    es: null, cid: '', topics: new Map(), reconnect: new Set(), inflight: false, timer: null, waiters: [],
    sub(topic, fn) {
      let set = this.topics.get(topic);
      if (!set) { set = new Set(); this.topics.set(topic, set); if (this.es) this.listen(topic); }
      set.add(fn);
      if (!this.es) this.open(); else this.pushSubs();
      return () => { set.delete(fn); if (!set.size) { this.topics.delete(topic); this.pushSubs(); } };
    },
    open() {
      if (!ES || this.es) return;
      this.es = new ES(BASE + '/api/realtime');
      this.es.addEventListener('PB_CONNECT', (ev) => {
        let id = ''; try { id = JSON.parse(ev.data).clientId || ''; } catch (_) {}
        const again = !!this.cid; this.cid = id; this.pushSubs();
        if (again) this.settled().then(() => { for (const f of this.reconnect) { try { f(); } catch (_) {} } });   // pas opnieuw laden als de abonnementen weer actief zijn
      });
      for (const t of this.topics.keys()) this.listen(t);
    },
    listen(topic) {
      this.es.addEventListener(topic, (ev) => {
        let d = null; try { d = JSON.parse(ev.data); } catch (_) { return; }
        const set = this.topics.get(topic); if (set && d) for (const f of [...set]) { try { f(d); } catch (e) { console.error(e); } }
      });
    },
    // abonnementen doorgeven aan de server; bij het opstarten komen er tientallen tegelijk, dus bundelen we ze in één aanvraag
    pushSubs() {
      if (!this.cid) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null; this.inflight = true;
        rawFetch('POST', '/api/realtime', { clientId: this.cid, subscriptions: [...this.topics.keys()] }).catch(() => {}).then(() => { this.inflight = false; if (!this.timer) this.release(); });
      }, 10);
    },
    release() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); },
    // wacht tot de abonnementen actief zijn (max. 3 seconden), zodat een bericht tussen het laden van de lijst en het abonneren niet gemist wordt
    settled() {
      return new Promise((res) => {
        if (!ES || (this.cid && !this.timer && !this.inflight)) return res();
        const t = setTimeout(res, 3000); this.waiters.push(() => { clearTimeout(t); res(); });
      });
    },
    close() { if (this.es) { try { this.es.close(); } catch (_) {} } this.es = null; this.cid = ''; },
  };

  // alle luisteraars per collectie, zodat een eigen wijziging meteen zichtbaar is (zonder op de server te wachten)
  const LIVE = new Map();
  function liveAdd(pb, fn) { let s = LIVE.get(pb); if (!s) LIVE.set(pb, (s = new Set())); s.add(fn); return () => s.delete(fn); }
  function notify(pb, action, record, fid) { const s = LIVE.get(pb); if (s) for (const f of [...s]) { try { f({ action, record, fid }); } catch (e) { console.error(e); } } }

  /* ================= filters en sorteren ================= */
  const valStr = (v) => (isTs(v) ? q(pbDate(v.toMillis())) : v instanceof Date ? q(pbDate(v.getTime())) : typeof v === 'string' ? q(v) : String(v));
  function whereToFilter(ad, w) {
    if (w.op === 'array-contains') { const f = ad.cq && ad.cq[w.field]; if (!f) throw unsupported('array-contains op ' + w.field); return f(w.value); }
    const f = pbField(ad, w.field);
    if (w.op === 'in') { if (!Array.isArray(w.value) || !w.value.length) return 'id = ""'; return '(' + w.value.map((v) => f + ' = ' + valStr(v)).join(' || ') + ')'; }
    const op = { '==': '=', '!=': '!=', '>': '>', '>=': '>=', '<': '<', '<=': '<=' }[w.op];
    if (!op) throw unsupported('where ' + w.op);
    return f + ' ' + op + ' ' + valStr(w.value);
  }
  function listParams(ad, S, sp) {
    const parts = [];
    if (ad.scope) for (const [k, v] of Object.entries(ad.scope(S))) if (k !== 'server' || !ad.scope(S).chan) parts.push(k + ' = ' + q(v));
    for (const w of sp.wheres) parts.push(whereToFilter(ad, w));
    const sort = sp.orders.map((o) => (o.dir === 'desc' ? '-' : '') + pbField(ad, o.field)).join(',');
    return { filter: parts.join(' && '), sort, max: sp.limit };
  }
  // dezelfde controle in de browser (voor realtime-gebeurtenissen), op het Firestore-document
  const cmpv = (v) => (isTs(v) ? v.toMillis() : v);
  function matchWhere(d, w) {
    const a = cmpv(d[w.field]), b = cmpv(w.value);
    switch (w.op) {
      case '==': return a === b; case '!=': return a !== b;
      case '>': return a !== undefined && a > b; case '>=': return a !== undefined && a >= b;
      case '<': return a !== undefined && a < b; case '<=': return a !== undefined && a <= b;
      case 'in': return Array.isArray(w.value) && w.value.indexOf(d[w.field]) >= 0;
      case 'array-contains': return Array.isArray(d[w.field]) && d[w.field].indexOf(w.value) >= 0;
      default: throw unsupported('where ' + w.op);
    }
  }
  function sortDocs(arr, orders) {
    if (!orders.length) return arr;
    return arr.sort((x, y) => {
      for (const o of orders) {
        const a = cmpv(x.data[o.field]), b = cmpv(y.data[o.field]);
        if (a === b) continue;
        if (a === undefined) return o.dir === 'desc' ? 1 : -1; if (b === undefined) return o.dir === 'desc' ? -1 : 1;
        return (a < b ? -1 : 1) * (o.dir === 'desc' ? -1 : 1);
      }
      return 0;
    });
  }

  /* ================= lezen ================= */
  async function getDoc(ref) {
    const { ad, S, fid, pbId } = await resolveDoc(ref);
    const r = await pbGet(ad, pbId);
    return new DocSnap(ref, r ? fromPB(ad, S, r) : null);
  }
  async function loadQuery(sp) {
    const { ad, S } = resolveCol(sp.col);
    let recs;
    if (ad.poll) recs = await pollFetch(ad, S, sp);
    else recs = await pbList(ad, listParams(ad, S, sp));
    return { ad, S, recs };
  }
  function buildDocs(ad, S, sp, recs) {
    let arr = recs.map((r) => ({ id: ad.fid ? ad.fid(r, S) : r.id, data: fromPB(ad, S, r) }));
    arr = arr.filter((x) => sp.wheres.every((w) => matchWhere(x.data, w)));
    sortDocs(arr, sp.orders);
    return sp.limit ? arr.slice(0, sp.limit) : arr;
  }
  async function getDocs(q_) {
    const sp = specOf(q_); const { ad, S, recs } = await loadQuery(sp);
    const arr = buildDocs(ad, S, sp, recs);
    return new QuerySnap(arr.map((x) => new DocSnap(doc(sp.col, x.id), x.data)), arr.map((x, i) => ({ type: 'added', doc: new DocSnap(doc(sp.col, x.id), x.data), oldIndex: -1, newIndex: i })));
  }

  /* beheerlijsten (moderatie, rapporten, abonnementen) komen van een route en worden elke paar seconden ververst */
  const pollCache = new Map();
  function pollFetch(ad, S, sp) {
    const route = typeof ad.poll.route === 'function' ? ad.poll.route(S) : ad.poll.route;
    let hit = pollCache.get(route);
    if (!hit || now() - hit.at > 1500) { hit = { at: now(), p: rawFetch('GET', route) }; pollCache.set(route, hit); }
    return hit.p.then((j) => (j && j[ad.poll.key(sp)]) || []);
  }
  const pollers = new Set(); let pollTimer = null;
  const pollTick = () => { for (const p of [...pollers]) p(); };
  function pollAdd(fn) {
    pollers.add(fn);
    if (!pollTimer) pollTimer = setInterval(pollTick, pollMs);
    return () => { pollers.delete(fn); if (!pollers.size && pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
  }
  const kick = () => { pollCache.clear(); pollTick(); };

  /* ================= luisteren (onSnapshot) ================= */
  function onSnapshot(target, next, err) {
    if (typeof next === 'object' && next) { err = next.error; next = next.next; }
    return target.kind === 'doc' ? listenDoc(target, next, err) : listenQuery(target, next, err);
  }
  function listenDoc(ref, next, err) {
    let dead = false, last, unsub = () => {}, off = () => {}, offLive = () => {};
    (async () => {
      let r;
      try { r = await resolveDoc(ref); } catch (e) { if (err) err(e); return; }
      const { ad, S, pbId } = r;
      const emit = (record) => {
        if (dead) return;
        const d = record ? fromPB(ad, S, record) : null; const sig = JSON.stringify(d);
        if (sig === last) return; last = sig; next(new DocSnap(ref, d));
      };
      const load = async () => { try { emit(await pbGet(ad, pbId)); } catch (e) { if (!dead && err) err(e); } };
      const handle = (ev) => { if (ev.record && ev.record.id === pbId) emit(ev.action === 'delete' ? null : ev.record); };
      if (dead) return;
      unsub = RT.sub(ad.pb + '/' + pbId, handle); offLive = liveAdd(ad.pb, handle); RT.reconnect.add(load); off = () => RT.reconnect.delete(load);
      await RT.settled();
      if (!dead) load();
    })();
    return () => { dead = true; unsub(); off(); offLive(); };
  }
  function listenQuery(q_, next, err) {
    const sp = specOf(q_);
    let dead = false, stops = [];
    let ad, S; try { ({ ad, S } = resolveCol(sp.col)); } catch (e) { setTimeout(() => err && err(e), 0); return () => {}; }
    const docs = new Map();      // Firestore-id -> document
    let prev = new Map(), first = true;
    const publish = () => {
      const arr = sortDocs([...docs.entries()].map(([id, data]) => ({ id, data })).filter((x) => sp.wheres.every((w) => matchWhere(x.data, w))), sp.orders);
      const view = sp.limit ? arr.slice(0, sp.limit) : arr;
      const cur = new Map(view.map((x) => [x.id, JSON.stringify(x.data)]));
      const changes = [];
      view.forEach((x, i) => {
        if (!prev.has(x.id)) changes.push({ type: 'added', doc: new DocSnap(doc(sp.col, x.id), x.data), oldIndex: -1, newIndex: i });
        else if (prev.get(x.id) !== cur.get(x.id)) changes.push({ type: 'modified', doc: new DocSnap(doc(sp.col, x.id), x.data), oldIndex: i, newIndex: i });
      });
      for (const id of prev.keys()) if (!cur.has(id)) changes.push({ type: 'removed', doc: new DocSnap(doc(sp.col, id), null), oldIndex: 0, newIndex: -1 });
      if (!first && !changes.length) return;
      first = false; prev = cur;
      next(new QuerySnap(view.map((x) => new DocSnap(doc(sp.col, x.id), x.data)), changes));
    };
    const fill = (recs) => { docs.clear(); for (const r of recs) docs.set(ad.fid ? ad.fid(r, S) : r.id, fromPB(ad, S, r)); publish(); };
    const load = async () => {
      try { const x = await loadQuery(sp); if (!dead) fill(x.recs); } catch (e) { if (!dead && err) err(e); }
    };
    if (ad.poll) {
      stops.push(pollAdd(load));
    } else {
      const scope = ad.scope ? ad.scope(S) : null;
      const inScope = (r) => !scope || Object.keys(scope).every((k) => (k === 'server' && scope.chan) || r[k] === scope[k]);
      const handle = (ev) => {
        const r = ev.record; if (dead || !r || !inScope(r)) return;
        const fid = ev.fid !== undefined ? ev.fid : (ad.fid ? ad.fid(r, S) : r.id);
        if (ev.action === 'delete') { docs.delete(fid); publish(); if (sp.limit && prev.size >= sp.limit) load(); return; }
        docs.set(fid, fromPB(ad, S, r)); publish();
      };
      stops.push(RT.sub(ad.pb + '/*', handle), liveAdd(ad.pb, handle));
      RT.reconnect.add(load); stops.push(() => RT.reconnect.delete(load));
      RT.settled().then(() => { if (!dead) load(); });
      return () => { dead = true; stops.forEach((f) => f()); };
    }
    load();
    return () => { dead = true; stops.forEach((f) => f()); };
  }

  /* ================= schrijven ================= */
  const stripScope = (ad, S, b) => { if (ad.scope) for (const k of Object.keys(ad.scope(S))) delete b[k]; return b; };
  async function createRec(ad, S, fid, pbId, data, serverPicks) {
    const b = toBody(ad, S, fid, data, 'create');
    if (ad.scope) Object.assign(b, ad.scope(S));
    if (ad.body && fid) Object.assign(b, ad.body(S, fid));
    if (!serverPicks) b.id = pbId;
    const r = await rawFetch('POST', '/api/collections/' + ad.pb + '/records', b);
    notify(ad.pb, 'create', r);
    return r;
  }
  async function patchRec(ad, S, fid, pbId, body) {
    stripScope(ad, S, body);
    const r = await rawFetch('PATCH', rec(ad.pb, pbId), body);
    notify(ad.pb, 'update', r);
    return r;
  }
  async function addDoc(colRef, data) {
    const { ad, S } = resolveCol(colRef);
    const fid = ad.clientId ? autoId() : '';
    if (ad.clientId) { const ref = doc(colRef, fid); await setDoc(ref, data); return ref; }
    const r = await createRec(ad, S, '', '', data, true);
    kick();
    return doc(colRef, ad.fid ? ad.fid(r, S) : r.id);
  }
  async function setDoc(ref, data, opts) {
    const { ad, S, fid, pbId } = await resolveDoc(ref);
    if (ad.pb === 'config' && fid === 'sparks') {   // Admin -> Sparks: de server schrijft dit zelf (alleen moderators), gewone gebruikers mogen niet in `config` schrijven
      const r = await rawFetch('POST', '/api/sparks-config', { modOnly: data.modOnly !== false });
      notify('config', 'update', Object.assign({ id: 'sparks' }, r)); kick(); return;
    }
    if (ad.serverId) { await createRec(ad, S, fid, pbId, data, true); return; }   // de server kiest het id (meldingen, logboeken, reacties van moderators)
    const mode = ad.set || (ad.clientId ? 'create' : 'patch');
    const tryCreate = () => createRec(ad, S, fid, pbId, data, false);
    const tryPatch = () => patchRec(ad, S, fid, pbId, toBody(ad, S, fid, data, 'update'));
    if (mode === 'create') {
      try { await tryCreate(); }
      catch (e) {
        if (e.status !== 400 && e.status !== 409) throw e;
        if (!ad.noOverwrite) { await tryPatch(); return; }
        // een naam of blokkade die al bestaat wordt niet overschreven; is het precies hetzelfde (jouw eigen claim), dan is het gelukt
        const cur = await pbGet(ad, pbId); const want = toBody(ad, S, fid, data, 'create');
        if (!cur || Object.keys(want).some((k) => JSON.stringify(cur[k]) !== JSON.stringify(want[k]))) throw e;
      }
    }
    else {
      try { await tryPatch(); }
      catch (e) {
        if (e.status === 404) await tryCreate();
        else if (e.status === 403) {   // PocketBase antwoordt 403 (niet 404) als wijzigen in deze collectie nooit mag: dan is aanmaken de enige mogelijkheid
          try { await tryCreate(); } catch (e2) { throw e2.status === 400 || e2.status === 409 ? e : e2; }
        } else throw e;
      }
    }
  }
  async function updateDoc(ref, data) {
    const { ad, S, fid, pbId } = await resolveDoc(ref);
    const keys = Object.keys(data);
    const rk = keys.find((k) => k.indexOf('reactions.') === 0);
    if (rk && ad.react) {
      const v = data[rk];
      const r = await rawFetch('POST', '/api/message-react', { coll: ad.pb, id: pbId, reactions: isFV(v, 'del') || !v ? [] : v });
      const row = await pbGet(ad, pbId); if (row) notify(ad.pb, 'update', row);
      return r;
    }
    const plain = {}, nested = {};
    for (const k of keys) {
      if (k.indexOf('.') > 0) { const [root, ...path] = k.split('.'); (nested[root] = nested[root] || []).push({ path, value: data[k] }); } else plain[k] = data[k];
    }
    const body = toBody(ad, S, fid, plain, 'update');
    const roots = Object.keys(nested);
    if (roots.length) {
      const cur = await pbGet(ad, pbId);
      if (!cur) throw new PBError(404, 'Dit document bestaat niet.', 'not-found');
      for (const root of roots) {
        const obj = clone(body[root] !== undefined ? body[root] : cur[root]) || {};
        for (const { path, value } of nested[root]) {
          let o = obj; for (let i = 0; i < path.length - 1; i++) { if (!o[path[i]] || typeof o[path[i]] !== 'object') o[path[i]] = {}; o = o[path[i]]; }
          const last = path[path.length - 1];
          if (isFV(value, 'del')) delete o[last]; else o[last] = nestedValue(value);
        }
        body[root] = obj;
      }
    }
    return patchRec(ad, S, fid, pbId, body);
  }
  async function deleteDoc(ref) {
    const { ad, S, fid, pbId } = await resolveDoc(ref);
    try {
      if (ad.pb === 'spamLocks') { await rawFetch('POST', '/api/spam-lift', { uid: fid }); kick(); return; }
      await rawFetch('DELETE', rec(ad.pb, pbId));
      notify(ad.pb, 'delete', Object.assign({ id: pbId }, ad.scope ? ad.scope(S) : {}), fid);
    } catch (e) { if (e.status !== 404) throw e; }
  }

  /* ================= batches en transacties ================= */
  // Firestore deed meerdere schrijfacties in één keer (alles of niets). Daar waar de server een route heeft (stap 4, 5, 8) wordt de batch één route-aanroep;
  // de rest gebeurt op volgorde, één voor één (niet atomair).
  class Batch {
    constructor() { this.ops = []; }
    set(ref, data, opts) { this.ops.push({ t: 'set', ref, data, opts }); return this; }
    update(ref, data) { this.ops.push({ t: 'update', ref, data }); return this; }
    delete(ref) { this.ops.push({ t: 'delete', ref }); return this; }
    async commit() { const ops = this.ops; this.ops = []; await runOps(ops); }
  }
  const writeBatch = () => new Batch();
  const col0 = (o) => o.ref.segs[0];
  const val = (v) => (isFV(v, 'ts') ? now() : isTs(v) ? v.toMillis() : v);
  function recognize(ops) {
    const used = new Set(), calls = [], after = [];
    const take = (pred) => ops.filter((o) => !used.has(o) && pred(o));
    const mark = (list) => list.forEach((o) => used.add(o));
    // spam-time-out: lock + logregel
    { const lock = take((o) => o.t === 'set' && col0(o) === 'spamLocks')[0], log = take((o) => o.t === 'set' && col0(o) === 'spamLog')[0];
      if (lock && log) { mark([lock, log]); calls.push(() => rawFetch('POST', '/api/spam-lock', { rule: lock.data.rule, reason: lock.data.reason, name: lock.data.name, msgs: log.data.msgs })); } }
    // moderatie: stand + logregel + melding
    { const m = take((o) => o.t === 'set' && col0(o) === 'moderation')[0], lg = take((o) => o.t === 'set' && col0(o) === 'modLog')[0], n = take((o) => o.t === 'set' && col0(o) === 'notifications')[0];
      if (m && lg && n) { mark([m, lg, n]);
        calls.push(() => rawFetch('POST', '/api/mod-action', { uid: lg.data.uid, kind: lg.data.kind, reasons: lg.data.reasons, note: lg.data.note, hours: lg.data.hours, notif: { title: n.data.title, text: n.data.text } })); } }
    // abonnement: stem, direct wijzigen, aanvragen
    { const sub = take((o) => col0(o) === 'subscriptions' && o.ref.segs.length === 2)[0];
      if (sub) {
        const users = take((o) => o.t === 'update' && col0(o) === 'users'), notes = take((o) => o.t === 'set' && col0(o) === 'notifications');
        const vk = sub.t === 'update' && Object.keys(sub.data).find((k) => k.indexOf('votes.') === 0);
        if (vk) { mark([sub, ...users, ...notes]); const v = sub.data[vk]; calls.push(() => rawFetch('POST', '/api/sub-vote', { uid: sub.ref.id, vote: v.v, note: v.note || '' })); }
        else if (sub.t === 'set' && sub.data.status === 'approved' && sub.data.decidedBy) { mark([sub, ...users, ...notes]); calls.push(() => rawFetch('POST', '/api/sub-admin-set', { uid: sub.ref.id, tier: sub.data.tier, note: sub.data.note || '' })); }
        else if (sub.t === 'set' && sub.data.status === 'pending' && sub.data.form) { mark([sub, ...notes]); calls.push(() => rawFetch('POST', '/api/sub-request', { tier: sub.data.tier, form: sub.data.form })); }
      } }
    // rapport behandelen (+ reactie, + melding aan de melder)
    { const r = take((o) => o.t === 'update' && col0(o) === 'reports' && o.ref.segs.length === 2)[0];
      if (r) {
        const note = take((o) => o.t === 'set' && col0(o) === 'reports' && o.ref.segs.length === 4 && o.ref.segs[2] === 'notes')[0]; mark([r]); if (note) mark([note]);
        const upd = {}; for (const k of ['status', 'plan', 'planBy', 'reviewBy', 'outcome', 'outcomeNote', 'handledByName']) if (k in r.data) upd[k] = r.data[k];
        calls.push(() => rawFetch('POST', '/api/report-update', { id: r.ref.id, upd, note: note ? { text: note.data.text, plan: note.data.plan || '' } : undefined }));
      } }
    // streak herstellen: streak + streakUsers
    { const s = take((o) => o.t === 'update' && col0(o) === 'streaks')[0], u = take((o) => o.t === 'set' && col0(o) === 'streakUsers')[0];
      if (s && u) { mark([s, u]); calls.push(async () => { await rawFetch('POST', '/api/streak-restore', { pair: s.ref.id }); if (s.data.day) { await patchRaw('streaks', s.ref.id, { day: s.data.day }); } }); } }
    // een server met zijn kanalen verwijderen: de kanalen verdwijnen op de server vanzelf mee
    { const sv = take((o) => o.t === 'delete' && col0(o) === 'servers' && o.ref.segs.length === 2).map((o) => o.ref.id);
      for (const o of take((o) => o.t === 'delete' && col0(o) === 'servers' && o.ref.segs.length === 4 && sv.indexOf(o.ref.segs[1]) >= 0)) used.add(o); }
    const rest = ops.filter((o) => !used.has(o));
    // gebruikersnamen: eerst de nieuwe vastleggen, dan het profiel, en pas daarna de oude naam loslaten
    const un = (o) => col0(o) === 'usernames';
    const ordered = [...rest.filter((o) => un(o) && o.t === 'set'), ...rest.filter((o) => !un(o)), ...rest.filter((o) => un(o) && o.t !== 'set')];
    return { calls, rest: ordered, routed: used.size > 0 };
  }
  async function patchRaw(pb, id, body) { const r = await rawFetch('PATCH', rec(pb, id), body); notify(pb, 'update', r); return r; }
  async function runOps(ops) {
    const { calls, rest, routed } = recognize(ops);
    for (const c of calls) await c();
    const run = async (o) => { if (o.t === 'set') return setDoc(o.ref, o.data, o.opts); if (o.t === 'update') return updateDoc(o.ref, o.data); return deleteDoc(o.ref); };
    // veel losse acties (bijvoorbeeld meldingen wissen): een paar tegelijk
    const bulk = rest.length > 8 && rest.every((o) => o.t === 'delete' || o.t === 'update');
    if (bulk) { for (let i = 0; i < rest.length; i += 6) await Promise.all(rest.slice(i, i + 6).map(run)); } else for (const o of rest) await run(o);
    if (routed) kick();
  }
  // een transactie: lezen, dan de schrijfacties in één keer achteraf (niet atomair; bij een conflict wint de laatste)
  async function runTransaction(_db, fn) {
    const writes = [];
    const tx = {
      get: (ref) => getDoc(ref),
      set: (ref, data, opts) => { writes.push({ t: 'set', ref, data, opts }); return tx; },
      update: (ref, data) => { writes.push({ t: 'update', ref, data }); return tx; },
      delete: (ref) => { writes.push({ t: 'delete', ref }); return tx; },
    };
    const out = await fn(tx);
    await runOps(writes);
    return out;
  }

  return { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, query, where, orderBy, limit, onSnapshot, serverTimestamp, writeBatch, arrayUnion, arrayRemove,
    deleteField, Timestamp, runTransaction, login, logout, setToken: (t) => { token = t; }, api: (method, path, body) => rawFetch(method, path, body), PBError, _rt: RT, _autoId: autoId, _adapters: ADAPTERS };
}
