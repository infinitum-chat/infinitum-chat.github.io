/* Infinitum push-dienst (Cloudflare Worker, gratis plan).
   Vervangt functions/index.js: de app roept deze Worker aan nadat er iets is aangemaakt (bericht, verzoek, melding...).
   De Worker controleert wie er belt (Firebase inlogtoken), leest het document zelf uit Firestore (zodat niemand
   zomaar meldingen kan sturen) en verstuurt de melding via Firebase Cloud Messaging.

   Instellingen in Cloudflare (Workers -> jouw Worker -> Settings -> Variables and Secrets):
     SERVICE_ACCOUNT  (Secret)  de hele inhoud van het JSON-bestand van je Firebase-servicesleutel
     PROJECT_ID       (Text)    chat-a5794
     ALLOWED_ORIGIN   (Text)    https://JOUWNAAM.github.io   (meerdere? scheid met een komma)  */

const FS = 'https://firestore.googleapis.com/v1';
const RECENT_MS = 5 * 60 * 1000;   // alleen documenten van de laatste 5 minuten (tegen herhaald afspelen)
const MAX_SENDS = 40;              // gratis plan: max 50 externe aanvragen per keer
const MAX_UIDS = 30;               // Firestore "IN"-zoekopdracht
const seen = new Map();            // dubbele aanvragen negeren (per isolate, best effort)
let tokCache = { value: '', exp: 0 };
let jwksCache = { keys: null, exp: 0 };

const enc = new TextEncoder();
const pid = (env) => env.PROJECT_ID || 'chat-a5794';
const clip = (t, n) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const b64u = (buf) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ''; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64uBytes = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64uJson = (s) => JSON.parse(new TextDecoder().decode(b64uBytes(s)));

/* ---------- inlogtoken van de gebruiker controleren ---------- */
async function jwks() {
  const now = Date.now();
  if (jwksCache.keys && jwksCache.exp > now) return jwksCache.keys;
  const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com', { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!r.ok) throw new Error('sleutels ophalen mislukt');
  jwksCache = { keys: (await r.json()).keys || [], exp: now + 3600 * 1000 };
  return jwksCache.keys;
}

async function verifyIdToken(env, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('geen geldig token');
  const header = b64uJson(parts[0]), payload = b64uJson(parts[1]);
  const now = Math.floor(Date.now() / 1000), p = pid(env);
  if (header.alg !== 'RS256') throw new Error('verkeerd type token');
  if (payload.aud !== p || payload.iss !== 'https://securetoken.google.com/' + p) throw new Error('token hoort bij een ander project');
  if (!payload.sub || payload.exp < now || payload.iat > now + 300) throw new Error('token verlopen');
  const jwk = (await jwks()).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('onbekende sleutel');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uBytes(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new Error('handtekening klopt niet');
  return payload.sub;
}

/* ---------- toegang tot Google (servicesleutel) ---------- */
async function accessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokCache.value && tokCache.exp - 60 > now) return tokCache.value;
  let key;
  try { key = JSON.parse(env.SERVICE_ACCOUNT); } catch { throw new Error('SERVICE_ACCOUNT ontbreekt of is geen geldige JSON'); }
  const head = b64u(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = b64u(enc.encode(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  })));
  const pem = String(key.private_key || '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const ck = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', ck, enc.encode(head + '.' + claim));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + head + '.' + claim + '.' + b64u(sig)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('toegangstoken mislukt: ' + (j.error_description || j.error || r.status));
  tokCache = { value: j.access_token, exp: now + (j.expires_in || 3600) };
  return tokCache.value;
}
async function gFetch(env, url, init = {}) {
  const t = await accessToken(env);
  return fetch(url, { ...init, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' } });
}

/* ---------- Firestore (REST) ---------- */
const docName = (env, path) => `projects/${pid(env)}/databases/(default)/documents/${path}`;
function fromFs(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);   // in milliseconden
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs);
  if ('mapValue' in v) return fromFields(v.mapValue.fields);
  return null;
}
function fromFields(f) { const o = {}; for (const [k, v] of Object.entries(f || {})) o[k] = fromFs(v); return o; }

// meerdere documenten in één aanvraag lezen; geeft { pad: data | null }
async function getDocs(env, paths) {
  const r = await gFetch(env, `${FS}/projects/${pid(env)}/databases/(default)/documents:batchGet`, {
    method: 'POST', body: JSON.stringify({ documents: paths.map(p => docName(env, p)) })
  });
  if (!r.ok) throw new Error('Firestore lezen mislukt (' + r.status + '): ' + (await r.text()).slice(0, 200));
  const byName = {};
  for (const x of await r.json()) if (x.found) byName[x.found.name] = fromFields(x.found.fields);
  const out = {};
  for (const p of paths) out[p] = byName[docName(env, p)] ?? null;
  return out;
}

async function getTokens(env, uids) {
  const value = uids.length === 1 ? { stringValue: uids[0] } : { arrayValue: { values: uids.map(u => ({ stringValue: u })) } };
  const r = await gFetch(env, `${FS}/projects/${pid(env)}/databases/(default)/documents:runQuery`, {
    method: 'POST',
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'pushTokens' }],
      where: { fieldFilter: { field: { fieldPath: 'uid' }, op: uids.length === 1 ? 'EQUAL' : 'IN', value } } } })
  });
  if (!r.ok) throw new Error('tokens zoeken mislukt (' + r.status + '): ' + (await r.text()).slice(0, 200));
  return (await r.json()).filter(x => x.document).map(x => ({
    name: x.document.name,
    token: decodeURIComponent(x.document.name.split('/').pop()),
    uid: fromFs(x.document.fields && x.document.fields.uid)
  }));
}

/* ---------- melding plannen en versturen ---------- */
// kind: 'dm' | 'server' | 'requests' (zelfde namen als de meldingsinstellingen in de app)
async function planPush(env, uids, kind, { title, body, open, tag, force }) {
  uids = [...new Set((uids || []).filter(Boolean))].slice(0, MAX_UIDS);
  const plan = { list: [], skipped: {}, reason: '' };
  if (!uids.length) { plan.reason = 'geen ontvangers'; return plan; }

  // eerst de tokens: wie geen toestel gekoppeld heeft, hoeft niet verder gelezen te worden
  const allToks = await getTokens(env, uids);
  const withTok = [...new Set(allToks.map(t => t.uid))];
  if (!withTok.length) { plan.reason = 'geen toestel gekoppeld: zet "Pushmeldingen op dit toestel" aan in de app'; return plan; }

  const paths = withTok.flatMap(u => [`settings/${u}`, `presenceSettings/${u}`, `presence/${u}`]);
  const docs = await getDocs(env, paths);
  const now = Date.now(), prefs = {}, ok = [];
  for (const u of withTok) {
    const set = docs[`settings/${u}`], dnd = docs[`presenceSettings/${u}`], pc = docs[`presence/${u}`];
    if (dnd && dnd.mode === 'dnd' && (!dnd.until || dnd.until > now)) { plan.skipped[u] = 'Niet storen staat aan'; continue; }
    if (!force && pc && pc.state === 'online' && pc.lastSeen && now - pc.lastSeen < 270000) { plan.skipped[u] = 'ontvanger is online op de pc'; continue; }
    const n = { dm: true, server: true, requests: true, preview: true, ...((set && set.notif) || {}) };
    if (n[kind] === false) { plan.skipped[u] = `meldingen voor "${kind}" staan uit in de instellingen`; continue; }
    prefs[u] = n; ok.push(u);
  }
  const toks = allToks.filter(t => ok.includes(t.uid));
  if (!toks.length) { plan.reason = Object.values(plan.skipped)[0] || 'geen ontvangers'; return plan; }

  plan.list = toks.slice(0, MAX_SENDS).map(t => ({
    t,
    data: {
      title: clip(title, 80),
      body: (prefs[t.uid] || {}).preview === false ? 'Nieuw bericht' : clip(body, 160),
      open: open || '', tag: tag || '', force: force ? '1' : ''
    }
  }));
  return plan;
}

async function sendFcm(env, token, data) {
  const r = await gFetch(env, `https://fcm.googleapis.com/v1/projects/${pid(env)}/messages:send`, {
    method: 'POST',
    // data-only: de service worker van de app (sw.js) toont de melding zelf
    body: JSON.stringify({ message: { token, data, webpush: { headers: { Urgency: 'high', TTL: '86400' } }, android: { priority: 'high' } } })
  });
  if (r.ok) return { ok: true };
  const e = ((await r.json().catch(() => ({}))).error) || {};
  const code = (e.details || []).map(d => d.errorCode).find(Boolean) || e.status || String(r.status);
  return { ok: false, code, message: e.message };
}

async function sendPlan(env, plan, label) {
  const res = await Promise.all(plan.list.map(async ({ t, data }) => ({ t, r: await sendFcm(env, t.token, data) })));
  const good = res.filter(x => x.r.ok).length;
  const bad = res.filter(x => !x.r.ok);
  bad.forEach(x => console.warn('Push mislukt', x.t.uid, x.r.code, x.r.message));
  console.log(`Push (${label}): ${good}/${res.length} gelukt`);
  // alleen tokens die echt niet meer bestaan worden verwijderd
  const dead = bad.filter(x => x.r.code === 'UNREGISTERED' || x.r.code === 'NOT_FOUND').slice(0, 5);
  await Promise.all(dead.map(x => gFetch(env, `${FS}/${x.t.name}`, { method: 'DELETE' }).catch(() => {})));
  return { sent: good, failed: bad.length };
}

/* ---------- aanvragen van de app ---------- */
const bad = (reason, status = 400) => ({ ok: false, reason, status });
const idOk = (v) => (/^[A-Za-z0-9_-]{1,160}$/.test(String(v || '')) ? String(v) : '');
const fresh = (ms) => typeof ms === 'number' && Date.now() - ms < RECENT_MS && ms - Date.now() < 60000;

async function handle(env, ctx, uid, b) {
  const type = String(b.type || '');
  let uids = [], kind = 'dm', msg = null;

  if (type === 'test') {
    // testpush: meteen controleren, en na 5 seconden versturen (zodat je de app nog kunt sluiten)
    const plan = await planPush(env, [uid], 'dm', { title: 'Infinitum testpush', body: 'Werkt! Zo komen echte meldingen binnen.', open: '', tag: 'infinitum-test', force: true });
    if (!plan.list.length) return { ok: false, status: 200, reason: plan.reason };
    ctx.waitUntil(sleep(5000).then(() => sendPlan(env, plan, 'test')).catch(e => console.error('Testpush mislukt', e)));
    return { ok: true, tokens: plan.list.length };
  }

  if (type === 'dm') {
    const chatId = idOk(b.chatId), mid = idOk(b.mid);
    if (!chatId || !mid || !chatId.split('_').includes(uid)) return bad('ongeldig gesprek');
    const path = `chats/${chatId}/messages/${mid}`;
    const m = (await getDocs(env, [path]))[path];
    if (!m || m.uid !== uid || !fresh(m.createdAt)) return bad('bericht niet gevonden of te oud');
    uids = chatId.split('_').filter(u => u && u !== uid); kind = 'dm';
    msg = { title: m.name || 'Nieuw bericht', body: m.text, open: `dm:${chatId}`, tag: 'infinitum-dm' };
  } else if (type === 'server') {
    const sid = idOk(b.sid), mid = idOk(b.mid);
    if (!sid || !mid) return bad('ongeldige server');
    const d = await getDocs(env, [`servers/${sid}`, `servers/${sid}/messages/${mid}`]);
    const s = d[`servers/${sid}`], m = d[`servers/${sid}/messages/${mid}`];
    if (!s || !m || m.uid !== uid || !(s.members || []).includes(uid) || !fresh(m.createdAt)) return bad('bericht niet gevonden of te oud');
    uids = (s.members || []).filter(u => u !== uid); kind = 'server';
    msg = { title: `${m.name || 'Iemand'} in ${s.name}`, body: m.text, open: `server:${sid}`, tag: 'infinitum-server' };
  } else if (type === 'friend') {
    const id = idOk(b.id);
    const f = id && (await getDocs(env, [`friendships/${id}`]))[`friendships/${id}`];
    if (!f || f.status !== 'pending' || f.requester !== uid || !fresh(f.createdAt)) return bad('verzoek niet gevonden of te oud');
    uids = (f.users || []).filter(u => u !== f.requester); kind = 'requests';
    msg = { title: (f.names && f.names[f.requester]) || 'Nieuw verzoek', body: 'wil vrienden worden', open: 'requests', tag: 'infinitum-requests' };
  } else if (type === 'inbox') {
    const nid = idOk(b.nid);
    const n = nid && (await getDocs(env, [`notifications/${nid}`]))[`notifications/${nid}`];
    if (!n || n.by !== uid || n.type === 'sub_request' || !fresh(n.createdAt)) return bad('melding niet gevonden of te oud');
    uids = [n.uid]; kind = 'requests';
    msg = { title: n.title || 'Melding', body: n.text, open: 'inbox', tag: 'infinitum-requests' };
  } else if (type === 'sub') {
    const d = await getDocs(env, [`subscriptions/${uid}`, 'badges/moderator']);
    const s = d[`subscriptions/${uid}`], mods = d['badges/moderator'];
    if (!s || s.status !== 'pending' || !fresh(s.requestedAt)) return bad('aanvraag niet gevonden of te oud');
    uids = ((mods && mods.users) || []).filter(u => u !== uid); kind = 'requests';
    msg = { title: s.username || 'Iemand', body: `vraagt ${s.tier === 'prime' ? 'Infinitum Prime' : 'Infinitum+'} aan`, open: 'admin', tag: 'infinitum-requests' };
  } else return bad('onbekend soort melding');

  // dubbele aanvragen (zelfde bericht nog eens) negeren
  const key = type + ':' + (b.mid || b.id || b.nid || uid);
  for (const [k, t] of seen) if (Date.now() - t > RECENT_MS) seen.delete(k);
  if (seen.has(key)) return { ok: true, duplicate: true };
  seen.set(key, Date.now());

  ctx.waitUntil((async () => {
    const plan = await planPush(env, uids, kind, msg);
    if (!plan.list.length) { console.log(`Push (${type}) overgeslagen: ${plan.reason}`, JSON.stringify(plan.skipped)); return; }
    await sendPlan(env, plan, type);
  })().catch(e => console.error('Push mislukt', e)));
  return { ok: true };
}

/* ---------- HTTP ---------- */
function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allow = env.ALLOWED_ORIGIN ? String(env.ALLOWED_ORIGIN).split(',').map(s => s.trim()).filter(Boolean) : null;
  const o = !allow ? '*' : (allow.includes(origin) ? origin : allow[0]);
  return {
    'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Max-Age': '86400', Vary: 'Origin'
  };
}
const json = (obj, status, cors) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    if (req.method === 'GET') return json({ ok: true, dienst: 'Infinitum push' }, 200, cors);
    if (req.method !== 'POST' || url.pathname !== '/notify') return json({ ok: false, reason: 'niet gevonden' }, 404, cors);

    let uid;
    try { uid = await verifyIdToken(env, (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')); }
    catch (e) { return json({ ok: false, reason: 'Niet ingelogd: ' + e.message }, 401, cors); }

    let body;
    try { body = await req.json(); } catch { return json({ ok: false, reason: 'ongeldige aanvraag' }, 400, cors); }

    try {
      const res = await handle(env, ctx, uid, body || {});
      return json(res, res.ok === false ? (res.status || 400) : 200, cors);
    } catch (e) {
      console.error('Fout', e);
      return json({ ok: false, reason: 'Serverfout: ' + e.message }, 500, cors);
    }
  }
};
