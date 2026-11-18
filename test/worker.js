/* Infinitum push-dienst (Cloudflare Worker, gratis plan).
   Vervangt functions/index.js: de app roept deze Worker aan nadat er iets is aangemaakt (bericht, verzoek, melding...).
   De Worker controleert wie er belt (Firebase inlogtoken), leest het document zelf uit Firestore (zodat niemand
   zomaar meldingen kan sturen) en verstuurt de melding via Firebase Cloud Messaging.

   Instellingen in Cloudflare (Workers -> jouw Worker -> Settings -> Variables and Secrets):
     SERVICE_ACCOUNT  (Secret)  de hele inhoud van het JSON-bestand van je Firebase-servicesleutel
     PROJECT_ID       (Text)    chat-a5794
     ALLOWED_ORIGIN   (Text)    https://JOUWNAAM.github.io   (meerdere? scheid met een komma)
   Bellen (v0.19), voor de gratis TURN-server van ExpressTURN (zie README, "Bellen instellen"):
     TURN_URL       (Text)    free.expressturn.com:3478   (het adres uit je ExpressTURN-dashboard)
     TURN_USERNAME  (Text)    de Username uit het dashboard
     TURN_PASSWORD  (Secret)  het Password uit het dashboard
   (Liever Cloudflare TURN? Dan kun je in plaats daarvan TURN_KEY_ID en TURN_KEY_API_TOKEN instellen; ExpressTURN gaat voor.)
   Zonder deze gegevens werkt bellen nog wel (met alleen STUN), maar lukt het niet op elk netwerk.
   Muziekstatus via Last.fm (v0.36):
     LASTFM_KEY     (Secret)  je Last.fm API-key (https://www.last.fm/api/account/create); zonder deze key werkt de muziekstatus niet.
   Muziek ook als Infinitum dicht is (v0.36): gebruikt dezelfde Cron Trigger (elke minuut) als de spraakkanalen, zie README bij v0.36.  */

const FS = 'https://firestore.googleapis.com/v1';
const RECENT_MS = 5 * 60 * 1000;   // alleen documenten van de laatste 5 minuten (tegen herhaald afspelen)
const MAX_SENDS = 30;              // gratis plan: max 50 externe aanvragen per keer (alles telt mee, ook het lezen en schrijven in Firestore)
const MAX_UIDS = 30;               // Firestore "IN"-zoekopdracht
const MAX_NOTIFS = 500;            // inbox-meldingen per bericht (bij @everyone in een grote server)
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

// veel documenten lezen: in stukken van 90 (elk stuk = 1 aanvraag)
async function getDocsMany(env, paths) {
  const parts = []; for (let i = 0; i < paths.length; i += 90) parts.push(paths.slice(i, i + 90));
  return Object.assign({}, ...(await Promise.all(parts.map(p => getDocs(env, p)))));
}
const toFs = (v) => typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { booleanValue: v } : v instanceof Date ? { timestampValue: v.toISOString() } : { nullValue: null };
// documenten schrijven (aanmaken of vervangen) met de rechten van de servicesleutel; max. 400 per aanvraag
async function writeDocs(env, docs) {
  for (let i = 0; i < docs.length; i += 400) {
    const writes = docs.slice(i, i + 400).map(({ path, data }) => ({ update: {
      name: docName(env, path), fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFs(v)])) } }));
    const r = await gFetch(env, `${FS}/projects/${pid(env)}/databases/(default)/documents:commit`, { method: 'POST', body: JSON.stringify({ writes }) });
    if (!r.ok) throw new Error('Firestore schrijven mislukt (' + r.status + '): ' + (await r.text()).slice(0, 200));
  }
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
    uid: fromFs(x.document.fields && x.document.fields.uid),
    ua: String(fromFs(x.document.fields && x.document.fields.ua) || '')
  }));
}

/* ---------- melding plannen en versturen ---------- */
// kind: 'dm' | 'server' | 'mention' | 'channel' | 'requests' (zelfde namen als de meldingsinstellingen in de app)
async function planPush(env, uids, kind, { title, body, open, tag, force }, { chunks = 1, max = MAX_SENDS, skipPc = false, phoneOnly = false } = {}) {
  uids = [...new Set((uids || []).filter(Boolean))].slice(0, MAX_UIDS * chunks);
  const plan = { list: [], skipped: {}, reason: '' };
  if (!uids.length) { plan.reason = 'geen ontvangers'; return plan; }

  // eerst de tokens: wie geen toestel gekoppeld heeft, hoeft niet verder gelezen te worden
  const parts = []; for (let i = 0; i < uids.length; i += MAX_UIDS) parts.push(uids.slice(i, i + MAX_UIDS));
  const allToks = (await Promise.all(parts.map(p => getTokens(env, p)))).flat();
  const withTok = [...new Set(allToks.map(t => t.uid))];
  if (!withTok.length) { plan.reason = 'geen toestel gekoppeld: zet "Pushmeldingen op dit toestel" aan in de app'; return plan; }

  const paths = withTok.flatMap(u => [`settings/${u}`, `presenceSettings/${u}`, `presence/${u}`, `presence/${u}_m`, `liveness/${u}`]);
  const docs = await getDocsMany(env, paths);
  const now = Date.now(), prefs = {}, ok = [];
  for (const u of withTok) {
    const set = docs[`settings/${u}`], dnd = docs[`presenceSettings/${u}`], pc = docs[`presence/${u}`], ph = docs[`presence/${u}_m`], lv = docs[`liveness/${u}`];
    if (dnd && dnd.mode === 'dnd' && (!dnd.until || dnd.until > now)) { plan.skipped[u] = 'Niet storen staat aan'; continue; }
    const n = { dm: true, server: true, mention: true, requests: true, call: true, preview: true, pcQuiet: true, ...((set && set.notif) || {}) };
    // zit de ontvanger op de pc (online, recente hartslag)? Dan geen push naar de telefoon, tenzij hij dat bij Instellingen -> Meldingen uitzette
    // v0.14: dit hangt niet meer af van je status (onzichtbaar/offline telt ook), maar van de hartslag in liveness/<uid>: app open op de pc
    // en de laatste 5 min iets gedaan (pcAway = false). Oudere apps zonder liveness vallen terug op de presence-hartslag.
    const pcHere = lv && lv.pcAt != null ? (!lv.pcAway && now - lv.pcAt < 270000)
      : !!(pc && pc.state === 'online' && pc.lastSeen && now - pc.lastSeen < 270000);
    if (!force && !skipPc && n.pcQuiet !== false && pcHere) { plan.skipped[u] = 'ontvanger zit achter de pc'; continue; }
    // v0.12: zit de ontvanger zelf in de app op de telefoon (online, verse hartslag van het toestel)? Dan toont de app de melding zelf; geen push erbij
    // (op iPhone toont de service worker een push altijd, ook als de app openstaat; daarom sturen we hem dan helemaal niet)
    const phHere = lv && lv.phAt != null ? (lv.phVis === true && now - lv.phAt < 100000)
      : !!(ph && ph.state === 'online' && ph.lastSeen && now - ph.lastSeen < 100000);
    if (!force && phHere) { plan.skipped[u] = 'ontvanger zit in de app op de telefoon'; continue; }
    if (n[kind] === false) { plan.skipped[u] = `meldingen voor "${kind}" staan uit in de instellingen`; continue; }
    prefs[u] = n; ok.push(u);
  }
  const toks = allToks.filter(t => ok.includes(t.uid) && (!phoneOnly || /Android|iPhone|iPad|iPod|Mobile/i.test(t.ua || '')));
  if (!toks.length) { plan.reason = Object.values(plan.skipped)[0] || 'geen ontvangers'; return plan; }

  plan.list = toks.slice(0, max).map(t => ({
    t,
    data: {
      title: clip(title, 80),
      body: kind !== 'call' && (prefs[t.uid] || {}).preview === false ? 'Nieuw bericht' : clip(body, 160),
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

/* ---------- servers: kanalen, rollen en mentions ----------
   Zelfde rechtenlogica als firestore.rules en de app: de eigenaar (officiële server: iedere moderator) kan alles,
   anderen via rollen (permIdx + mroles). Dit vervangt wat functions/index.js deed (Cloud Functions hebben het Blaze-plan nodig). */
const GENERAL = 'general';
const roleIdsOf = (srv, uid) => [...((srv.mroles && srv.mroles[uid]) || []), 'everyone'];
const srvHasPerm = (srv, mods, uid, p) => (srv.official ? mods.has(uid) : srv.ownerId === uid)
  || roleIdsOf(srv, uid).some(r => ((srv.permIdx || {})[p] || []).includes(r) || ((srv.permIdx || {}).admin || []).includes(r));
const srvAclHit = (srv, uid, list) => Array.isArray(list) && list.some(t => t === 'everyone' || t === 'u:' + uid || roleIdsOf(srv, uid).includes(t));
const srvCanView = (srv, mods, ch, uid) => srvHasPerm(srv, mods, uid, 'admin') || !(ch.acl && ch.acl.view) || srvAclHit(srv, uid, ch.acl.view);

/* ---------- aanvragen van de app ---------- */
const bad = (reason, status = 400) => ({ ok: false, reason, status });
const idOk = (v) => (/^[A-Za-z0-9_-]{1,160}$/.test(String(v || '')) ? String(v) : '');
const fresh = (ms) => typeof ms === 'number' && Date.now() - ms < RECENT_MS && ms - Date.now() < 60000;

async function handle(env, ctx, uid, b) {
  const type = String(b.type || '');
  let uids = [], kind = 'dm', msg = null, groups = null, writes = [], extraKey = '';

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
    const sid = idOk(b.sid), mid = idOk(b.mid), cid = idOk(b.cid) || GENERAL;
    if (!sid || !mid) return bad('ongeldige server');
    const mpath = cid === GENERAL ? `servers/${sid}/messages/${mid}` : `servers/${sid}/channels/${cid}/messages/${mid}`;
    const d = await getDocs(env, [`servers/${sid}`, mpath, `servers/${sid}/channels/${cid}`, 'badges/moderator', 'badges/admin']);
    const s = d[`servers/${sid}`], m = d[mpath], chDoc = d[`servers/${sid}/channels/${cid}`];
    if (!s || !m || m.uid !== uid || !(s.members || []).includes(uid) || !fresh(m.createdAt)) return bad('bericht niet gevonden of te oud');
    if (cid !== GENERAL && !chDoc) return bad('kanaal niet gevonden');
    const ch = chDoc || { name: 'algemeen' };
    const mods = new Set([...(((d['badges/moderator'] || {}).users) || []), ...(((d['badges/admin'] || {}).users) || [])]);
    // alleen wie het kanaal mag zien krijgt iets te horen (privékanalen lekken niet)
    const viewers = new Set((s.members || []).filter(u => u !== uid && srvCanView(s, mods, ch, u)));
    // wie is getagd? (het recht om @everyone/rollen te gebruiken is al door de beveiligingsregels gecontroleerd bij het opslaan)
    const mn = m.mentions || {}, mentioned = new Set();
    for (const u of mn.users || []) if (viewers.has(u)) mentioned.add(u);
    if (mn.everyone) viewers.forEach(u => mentioned.add(u));
    for (const rid of mn.roles || []) for (const u of viewers) if (((s.mroles || {})[u] || []).includes(rid)) mentioned.add(u);
    const where = `${s.name} #${ch.name}`, open = `server:${sid}:${cid}`, who = String(m.name || '').slice(0, 20) || 'Iemand';
    groups = [];
    // v0.34 kanaalmeldingen: staat bij dit kanaal "Iedereen krijgt bij elk bericht een melding" (notifyAll) aan, dan krijgt iedereen die het mag zien een melding bij elk bericht,
    // los van @mentions en @everyone en los van de meldingsinstellingen "Servers" en "Vermeldingen" (Niet storen blijft gelden).
    if (ch.notifyAll === true) {
      const all = [...viewers].slice(0, MAX_NOTIFS), pinged = all.filter(u => mentioned.has(u)), rest = all.filter(u => !mentioned.has(u));
      if (pinged.length) groups.push({ uids: pinged, kind: 'channel', chunks: 3, msg: { title: `${who} noemde je in ${where}`, body: m.text, open, tag: 'infinitum-mention' } });
      if (rest.length) groups.push({ uids: rest, kind: 'channel', chunks: 3, msg: { title: `${who} in ${where}`, body: m.text, open, tag: 'infinitum-channel' } });
    } else {
    const list = [...mentioned].slice(0, MAX_NOTIFS);
    // vermeldingen komen niet meer in de inbox (de bel): de app toont ze als teller bij Servers -> server -> kanaal. Alleen de push blijft.
    if (list.length) groups.push({ uids: list, kind: 'mention', chunks: 3, msg: { title: `${who} noemde je in ${where}`, body: m.text, open, tag: 'infinitum-mention' } });
    // gewone berichten: alleen niet-officiële servers melden alles; de officiële server alleen bij mentions
    if (!s.official) {
      const rest = [...viewers].filter(u => !mentioned.has(u));
      if (rest.length) groups.push({ uids: rest, kind: 'server', chunks: 1, msg: { title: `${who} in ${where}`, body: m.text, open, tag: 'infinitum-server' } });
    }
    }
  } else if (type === 'friend') {
    const id = idOk(b.id);
    const f = id && (await getDocs(env, [`friendships/${id}`]))[`friendships/${id}`];
    if (!f || f.status !== 'pending' || f.requester !== uid || !fresh(f.createdAt)) return bad('verzoek niet gevonden of te oud');
    uids = (f.users || []).filter(u => u !== f.requester); kind = 'requests';
    msg = { title: (f.names && f.names[f.requester]) || 'Nieuw verzoek', body: 'wil vrienden worden', open: 'requests', tag: 'infinitum-requests' };
  } else if (type === 'streakr') {
    // v0.13: iemand stuurt je een streakr (foto die je 1x kunt bekijken)
    const sid = idOk(b.sid), path = `snaps/${sid}`;
    const sn = sid && (await getDocs(env, [path]))[path];
    if (!sn || sn.from !== uid || !sn.to || !fresh(sn.createdAt)) return bad('streakr niet gevonden of te oud');
    uids = [sn.to]; kind = 'dm';
    msg = { title: sn.name || 'Streakr', body: 'heeft een streakr gestuurd', open: 'streakr', tag: 'infinitum-streakr' };
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
  } else if (type === 'call') {
    // v0.19: iemand belt je (calls/<uid van de beller>); alleen een verse oproep waar jij de beller van bent
    const cid = idOk(b.callId);
    if (!cid || cid !== uid) return bad('ongeldige oproep');
    const c = (await getDocs(env, [`calls/${cid}`]))[`calls/${cid}`];
    if (!c || c.caller !== uid || c.status !== 'ringing' || !c.callee || !fresh(c.createdAt)) return bad('oproep niet gevonden of te oud');
    uids = [c.callee]; kind = 'call'; extraKey = String(c.createdAt);
    msg = { title: `${clip(c.callerName, 20) || 'Iemand'} belt je`, body: 'Tik om op te nemen', open: `dm:${c.chatId || ''}`, tag: 'infinitum-call' };
  } else if (type === 'digest') {
    // v0.14: je ging van je pc af en er staat nog wat open: één melding naar je telefoon(s) (nooit naar een pc-browser)
    const n = Math.min(999, Math.max(0, Math.floor(+b.n || 0)));
    if (!n) return bad('niets om te melden');
    uids = [uid]; kind = 'dm';
    msg = { title: 'Infinitum', body: n === 1 ? 'Je hebt nog 1 ongelezen bericht open staan.' : `Je hebt nog ${n} ongelezen berichten open staan.`, open: '', tag: 'infinitum-digest' };
  } else return bad('onbekend soort melding');

  // dubbele aanvragen (zelfde bericht nog eens) negeren
  const key = type + ':' + (b.mid || b.sid || b.id || b.nid || uid) + (type === 'digest' ? ':' + Math.floor(Date.now() / 60000) : '') + (extraKey ? ':' + extraKey : '');
  for (const [k, t] of seen) if (Date.now() - t > RECENT_MS) seen.delete(k);
  if (seen.has(key)) return { ok: true, duplicate: true };
  seen.set(key, Date.now());

  if (!groups) groups = [{ uids, kind, msg, chunks: 1, opts: type === 'digest' ? { skipPc: true, phoneOnly: true } : {} }];
  ctx.waitUntil((async () => {
    // 1) de inbox-meldingen (de bel in de app), 2) push naar de toestellen; vermeldingen eerst, dan de rest, samen max. MAX_SENDS
    if (writes.length) await writeDocs(env, writes).catch(e => console.error('Inbox-meldingen schrijven mislukt', e));
    let budget = MAX_SENDS;
    for (const g of groups) {
      if (budget <= 0) break;
      const plan = await planPush(env, g.uids, g.kind, g.msg, { chunks: g.chunks, max: budget, ...(g.opts || {}) });
      if (!plan.list.length) { console.log(`Push (${type}/${g.kind}) overgeslagen: ${plan.reason}`, JSON.stringify(plan.skipped)); continue; }
      budget -= plan.list.length;
      await sendPlan(env, plan, `${type}/${g.kind}`);
    }
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
/* ---------- foto's: opslaan in Cloudflare R2 (origineel, dus scherp) en uitleveren ----------
   Instellen: Cloudflare -> R2 -> Create bucket (bijv. infinitum-media); daarna Workers -> jouw Worker -> Settings -> Bindings ->
   Add -> R2 bucket -> Variable name = MEDIA, kies de bucket. Zonder die koppeling werkt alleen het versturen van foto's niet. */
const MAX_UPLOAD = 10 * 1024 * 1024;
const MEDIA_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
function sniffImage(b) {   // de echte inhoud moet bij het opgegeven type passen (niemand kan zo een html-bestand uploaden)
  const at = (i) => b[i];
  if (at(0) === 0xFF && at(1) === 0xD8 && at(2) === 0xFF) return 'image/jpeg';
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4E && at(3) === 0x47) return 'image/png';
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return 'image/webp';
  return '';
}
async function upload(req, env, uid, url, cors) {
  if (!env.MEDIA) return json({ ok: false, reason: 'Foto’s zijn nog niet ingesteld: koppel een R2-bucket met de naam MEDIA aan de Worker.' }, 503, cors);
  const len = +(req.headers.get('Content-Length') || 0);
  if (len > MAX_UPLOAD) return json({ ok: false, reason: 'Deze foto is te groot (max. 10 MB).' }, 413, cors);
  const claimed = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!MEDIA_TYPES[claimed]) return json({ ok: false, reason: 'Alleen jpg, png, webp en gif.' }, 415, cors);
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return json({ ok: false, reason: 'Leeg bestand.' }, 400, cors);
  if (buf.byteLength > MAX_UPLOAD) return json({ ok: false, reason: 'Deze foto is te groot (max. 10 MB).' }, 413, cors);
  const real = sniffImage(new Uint8Array(buf, 0, Math.min(16, buf.byteLength)));
  if (!real || real !== claimed) return json({ ok: false, reason: 'Dit is geen geldige afbeelding.' }, 415, cors);
  const rnd = [...crypto.getRandomValues(new Uint8Array(9))].map(x => x.toString(16).padStart(2, '0')).join('');
  const key = `u/${uid}/${Date.now().toString(36)}-${rnd}.${MEDIA_TYPES[real]}`;
  await env.MEDIA.put(key, buf, { httpMetadata: { contentType: real, cacheControl: 'public, max-age=31536000, immutable' } });
  return json({ ok: true, url: `${url.origin}/m/${key}` }, 200, cors);
}
async function serveMedia(req, env, url) {
  const h = { 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Cross-Origin-Resource-Policy': 'cross-origin' };
  let key = '';
  try { key = decodeURIComponent(url.pathname.slice(3)); } catch { return new Response('niet gevonden', { status: 404, headers: h }); }
  if (!env.MEDIA || !/^[A-Za-z0-9_\-./]{1,200}$/.test(key) || key.includes('..')) return new Response('niet gevonden', { status: 404, headers: h });
  const obj = await env.MEDIA.get(key);
  if (!obj) return new Response('niet gevonden', { status: 404, headers: h });
  if (req.headers.get('If-None-Match') === obj.httpEtag) return new Response(null, { status: 304, headers: { ...h, ETag: obj.httpEtag } });
  return new Response(obj.body, { headers: { ...h, 'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable', ETag: obj.httpEtag } });
}

/* ---------- bellen: TURN-gegevens (ExpressTURN gratis, of Cloudflare Realtime) ----------
   De gegevens blijven hier in de Worker (nooit in de website). Alleen Prime-leden (die bellen) en wie op dat moment gebeld wordt krijgen gegevens. */
async function turn(req, env, uid, url, cors) {
  const fixed = !!(env.TURN_URL && env.TURN_USERNAME && env.TURN_PASSWORD);   // ExpressTURN (vaste gegevens)
  if (!fixed && !(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN)) return json({ ok: false, reason: 'TURN is nog niet ingesteld in de Worker (TURN_URL, TURN_USERNAME en TURN_PASSWORD).' }, 503, cors);
  const callId = idOk(url.searchParams.get('call'));
  const paths = [`users/${uid}`]; if (callId) paths.push(`calls/${callId}`);
  // v0.20: spraakkanaal (?vc=<server>:<kanaal>): iedere deelnemer van die server mag TURN gebruiken voor een spraakkanaal
  const [vsid, vcid] = String(url.searchParams.get('vc') || '').split(':').map(idOk);
  if (vsid && vcid) paths.push(`servers/${vsid}`, `servers/${vsid}/channels/${vcid}`);
  const d = await getDocs(env, paths);
  const me = d[`users/${uid}`], c = callId ? d[`calls/${callId}`] : null;
  const prime = !!me && me.tier === 'prime';
  const gebeld = !!c && c.callee === uid && (c.status === 'ringing' || c.status === 'accepted') && fresh(c.createdAt);
  const vsrv = vsid && vcid ? d[`servers/${vsid}`] : null, vch = vsid && vcid ? d[`servers/${vsid}/channels/${vcid}`] : null;
  const inVoice = !!vsrv && Array.isArray(vsrv.members) && vsrv.members.includes(uid) && !!vch && vch.type === 'voice';
  if (!prime && !gebeld && !inVoice) return json({ ok: false, reason: 'Alleen Prime-leden, wie gebeld wordt of deelnemers van een spraakkanaal kunnen TURN gebruiken.' }, 403, cors);
  if (fixed) {
    const host = String(env.TURN_URL).trim().replace(/^turns?:/i, '').replace(/^\/\//, '');
    return json({ ok: true, iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
      { urls: [`turn:${host}`, `turn:${host}?transport=tcp`], username: String(env.TURN_USERNAME).trim(), credential: String(env.TURN_PASSWORD).trim() }
    ] }, 200, cors);
  }
  const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + env.TURN_KEY_API_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: 4 * 3600 })   // 4 uur: ruim genoeg voor een gesprek
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('TURN mislukt', r.status, JSON.stringify(j).slice(0, 200)); return json({ ok: false, reason: 'Cloudflare TURN gaf een fout (' + r.status + '). Controleer TURN_KEY_ID en TURN_KEY_API_TOKEN.' }, 502, cors); }
  const list = Array.isArray(j.iceServers) ? j.iceServers : j.iceServers ? [j.iceServers] : [];
  return json({ ok: true, iceServers: list }, 200, cors);
}

/* ---------- spraakkanalen: achtergebleven deelnemers opruimen (v0.34) ----------
   Elke deelnemer van een spraakkanaal ververst elke 40 s zijn document servers/<s>/channels/<k>/voice/<uid> (veld `at`). Valt iemands verbinding
   weg (stroom, wifi, crash, browser dicht), dan blijft dat document staan en lijkt hij verbonden. Een Cron Trigger (elke minuut, zie README) roept
   sweepVoice aan: wie langer dan VOICE_STALE_MS niets liet horen wordt uit het kanaal gehaald, samen met zijn verbindingsgegevens (sigs). */
const VOICE_STALE_MS = 110000;
async function sweepVoice(env) {
  const base = `${FS}/projects/${pid(env)}/databases/(default)/documents`;
  const r = await gFetch(env, `${base}:runQuery`, { method: 'POST', body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'voice', allDescendants: true }], limit: 1000 } }) });
  if (!r.ok) throw new Error('voice lezen mislukt (' + r.status + '): ' + (await r.text()).slice(0, 200));
  const now = Date.now(); let removed = 0;
  for (const row of await r.json()) {
    const d = row.document; if (!d) continue;
    const at = d.fields && d.fields.at && d.fields.at.timestampValue ? Date.parse(d.fields.at.timestampValue) : 0;
    if (at && now - at < VOICE_STALE_MS) continue;
    const m = d.name.match(/\/servers\/([^/]+)\/channels\/([^/]+)\/voice\/([^/]+)$/); if (!m) continue;
    const [, sid, cid, uid] = m;
    await gFetch(env, `${FS}/${d.name}`, { method: 'DELETE' }).catch(() => {});
    // verbindingsgegevens van of naar deze deelnemer
    try {
      const sr = await gFetch(env, `${base}/servers/${sid}/channels/${cid}/sigs?pageSize=100&mask.fieldPaths=from`);
      if (sr.ok) for (const sd of ((await sr.json()).documents || [])) {
        const id = sd.name.split('/').pop();
        if (id.startsWith(uid + '_') || id.endsWith('_' + uid)) await gFetch(env, `${FS}/${sd.name}`, { method: 'DELETE' }).catch(() => {});
      }
    } catch {}
    removed++; console.log(`Spraak opgeruimd: ${uid} uit ${sid}/${cid} (${at ? Math.round((now - at) / 1000) + ' s stil' : 'zonder hartslag'})`);
  }
  return removed;
}

/* ---------- Last.fm (v0.36): wat speelt iemand nu? ----------
   De app vraagt dit elke ~45 s voor je EIGEN Last.fm-naam (alleen als je muziekstatus aan staat) en zet het resultaat in je profiel.
   De API-key blijft hier in de Worker (niet in de app). Instellen: Cloudflare -> jouw Worker -> Settings -> Variables and Secrets ->
   LASTFM_KEY (Secret) = je Last.fm API-key (gratis: https://www.last.fm/api/account/create). */
const LFM_RE = /^[A-Za-z][A-Za-z0-9_-]{1,14}$/;
const LFM_PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f';   // het standaard-sterretje van Last.fm: geen echte hoes
const LFM_GRACE = 180;                                        // een nummer dat < 3 min geleden is gescrobbeld telt ook nog als "speelt nu" (sommige apps sturen geen "now playing")
const LFM_ART_OK = /^https:\/\/(?:lastfm\.freetls\.fastly\.net|is\d-ssl\.mzstatic\.com|(?:e-)?cdns?-images\.dzcdn\.net)\//;   // Last.fm-hoes, of (als Last.fm er geen heeft) Deezer of Apple/iTunes
const artCache = new Map();                                   // "artiest|titel" -> { exp, art }; hoezen veranderen niet, dus lang bewaren
const lfmCache = new Map();                                   // naam -> { exp, data }; alleen in dit isolate (de Cache API werkt niet op *.workers.dev)
const LFM_ERR = {
  6:  ['nouser',  'Deze naam bestaat niet op Last.fm. Controleer de spelling (zonder @).'],
  17: ['private', 'Je luistergeschiedenis op Last.fm is privé. Zet in Last.fm bij Instellingen → Privacy de optie om recent geluisterde nummers te verbergen uit.'],
  10: ['badkey',  'De Last.fm API-key in de Worker is ongeldig. De beheerder moet LASTFM_KEY controleren.'],
  26: ['badkey',  'De Last.fm API-key in de Worker is geblokkeerd. De beheerder moet LASTFM_KEY controleren.'],
  29: ['slow',    'Last.fm krijgt even te veel aanvragen. Probeer het over een minuut opnieuw.']
};
// geeft { s: HTTP-status of 'err', j: json of null }; de status gebruiken we in de diagnose
const fetchJson = async (u, ms) => {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms || 3500);
  try {
    const r = await fetch(u, { headers: { 'User-Agent': 'Infinitum/0.36 (+Cloudflare Worker)', 'Accept': 'application/json' }, signal: c.signal });
    return { s: r.status, j: r.ok ? await r.json().catch(() => null) : null };
  } catch { return { s: 'err', j: null }; } finally { clearTimeout(t); }
};
const pickLfmImg = (imgs) => [].concat(imgs || []).map(x => String((x && x['#text']) || '')).filter(Boolean).reverse()
  .find(u => u.startsWith('https://lastfm.freetls.fastly.net/') && !u.includes(LFM_PLACEHOLDER) && u.length <= 300) || '';
const normTxt = (v) => String(v || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const artistParts = (artist) => String(artist).split(/,|&|;|\/|\bfeat\.?|\bft\.?|\bx\b/i).map(s => s.trim()).filter(Boolean);
// klopt dit zoekresultaat echt met het nummer? (liever geen hoes dan een verkeerde)
function sameSong(artist, title, xa, xt) {
  const A = normTxt(xa), T = normTxt(xt), nt = normTxt(title);
  return !!(A && T && artistParts(artist).map(normTxt).filter(Boolean).some(na => A.includes(na) || na.includes(A)) && (T.includes(nt) || nt.includes(T)));
}
const okArt = (u) => typeof u === 'string' && u.length <= 300 && LFM_ART_OK.test(u);

// Bron 1: Last.fm track.getInfo (kent vaak het album, ook als de scrobbler dat niet meestuurde)
async function artFromLastfm(env, artist, title) {
  const r = await fetchJson('https://ws.audioscrobbler.com/2.0/?method=track.getinfo&autocorrect=1&format=json&artist=' + encodeURIComponent(artist)
    + '&track=' + encodeURIComponent(title) + '&api_key=' + encodeURIComponent(String(env.LASTFM_KEY).trim()));
  const art = r.j && r.j.track && r.j.track.album ? pickLfmImg(r.j.track.album.image) : '';
  return { art, note: art ? 'ok' : (r.s === 200 ? 'geen' : 'fout ' + r.s) };
}
// Bron 2: Deezer (gratis, geen sleutel). Eerst een nauwkeurige zoekopdracht, anders een gewone.
async function artFromDeezer(artist, title) {
  const first = artistParts(artist)[0] || artist;
  let last = 'geen';
  for (const q of ['artist:"' + first.replace(/"/g, '') + '" track:"' + String(title).replace(/"/g, '') + '"', artist + ' ' + title]) {
    const r = await fetchJson('https://api.deezer.com/search/track?limit=8&q=' + encodeURIComponent(q));
    if (r.s !== 200 || !r.j) { last = 'fout ' + r.s; continue; }
    if (r.j.error) { last = 'fout ' + (r.j.error.code || r.j.error.type || '?'); continue; }
    const m = (r.j.data || []).find(x => x && x.album && sameSong(artist, title, x.artist && x.artist.name, x.title || x.title_short));
    const al = m && m.album, art = al && [al.cover_big, al.cover_xl, al.cover_medium].find(okArt);
    if (art) return { art, note: 'ok' };
  }
  return { art: '', note: last };
}
// Bron 3: iTunes Search (Amerikaanse en Nederlandse winkel)
async function artFromItunes(artist, title) {
  let last = 'geen';
  for (const c of ['', '&country=NL']) {
    const r = await fetchJson('https://itunes.apple.com/search?media=music&entity=song&limit=10' + c + '&term=' + encodeURIComponent(artist + ' ' + title));
    if (r.s !== 200 || !r.j) { last = 'fout ' + r.s; continue; }
    const m = (r.j.results || []).find(x => x && x.artworkUrl100 && sameSong(artist, title, x.artistName, x.trackName));
    if (m) { const u = String(m.artworkUrl100).replace(/\/\d+x\d+(bb)?\.(jpg|png)$/i, '/300x300bb.$2'); if (okArt(u)) return { art: u, note: 'ok' }; }
  }
  return { art: '', note: last };
}
// Alle bronnen tegelijk (snel), daarna de eerste die iets vond: Last.fm, Deezer, iTunes.
async function findArt(env, artist, title) {
  const key = (artist + '|' + title).toLowerCase(), hit = artCache.get(key);
  if (hit && hit.exp > Date.now()) return hit;
  const [lf, dz, it] = await Promise.all([artFromLastfm(env, artist, title), artFromDeezer(artist, title), artFromItunes(artist, title)]);
  const art = lf.art || dz.art || it.art || '';
  const res = { art, dbg: art ? '' : 'Last.fm: ' + lf.note + ', Deezer: ' + dz.note + ', iTunes: ' + it.note, exp: Date.now() + (art ? 6 * 3600e3 : 5 * 60e3) };   // niets gevonden: na 5 min opnieuw proberen
  if (artCache.size > 500) artCache.clear();
  artCache.set(key, res);
  return res;
}
// Vraagt Last.fm wat er NU speelt bij `user`. Geeft { status, data } terug; zowel de app (via /lastfm) als de achtergrond-poller (pollMusic) gebruiken dit.
async function lfmNow(env, user) {
  if (!LFM_RE.test(user)) return { status: 400, data: { ok: false, code: 'badname', reason: 'Dit is geen geldige Last.fm-naam (2 tot 15 tekens: letters, cijfers, _ en -).' } };
  if (!env.LASTFM_KEY) return { status: 503, data: { ok: false, code: 'nokey', reason: 'Last.fm is nog niet ingesteld: de beheerder moet LASTFM_KEY in de Worker zetten (zie README).' } };

  const ck = user.toLowerCase(), hit = lfmCache.get(ck);
  if (hit && hit.exp > Date.now()) return { status: 200, data: hit.data };

  const api = 'https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&limit=1&format=json'
    + '&user=' + encodeURIComponent(user) + '&api_key=' + encodeURIComponent(String(env.LASTFM_KEY).trim());
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 6000);
  let r, j;
  try {
    r = await fetch(api, { headers: { 'User-Agent': 'Infinitum/0.36 (+Cloudflare Worker)' }, signal: ctl.signal });
    j = await r.json().catch(() => null);
  } catch (e) {
    return { status: 502, data: { ok: false, code: 'down', reason: 'Last.fm antwoordt niet. Probeer het later opnieuw.' } };
  } finally { clearTimeout(to); }

  if (j && j.error) {
    const [code, reason] = LFM_ERR[j.error] || ['error', 'Last.fm gaf een fout (' + j.error + ').'];
    return { status: code === 'nouser' || code === 'private' ? 200 : 502, data: { ok: false, code, reason } };
  }
  const list = j && j.recenttracks ? [].concat(j.recenttracks.track || []) : [];
  if (!r.ok || !j || !j.recenttracks) return { status: 502, data: { ok: false, code: 'error', reason: 'Last.fm gaf een onverwacht antwoord (' + r.status + ').' } };

  let data = { ok: true, playing: false, v: 3 };
  const t = list[0];
  if (t) {
    const now = t['@attr'] && String(t['@attr'].nowplaying) === 'true';
    const uts = Number(t.date && t.date.uts) || 0;
    const fresh = !now && uts && (Date.now() / 1000 - uts) < LFM_GRACE;
    const title = clip(t.name, 120), artist = clip(t.artist && (t.artist['#text'] || t.artist.name), 120);
    if ((now || fresh) && title && artist) {
      let art = pickLfmImg(t.image), dbg = '';
      if (!art) { const f = await findArt(env, artist, title); art = f.art; dbg = f.dbg; }
      if (!okArt(art)) art = '';
      data = { ok: true, playing: true, title, artist, art, live: !!now, v: 3, dbg: art ? '' : dbg };
    }
  }
  if (lfmCache.size > 500) lfmCache.clear();
  lfmCache.set(ck, { exp: Date.now() + 20000, data });
  return { status: 200, data };
}
async function lastfm(req, env, uid, cors) {
  let body; try { body = await req.json(); } catch { body = {}; }
  const user = String((body && body.user) || '').trim();
  const r = await lfmNow(env, user);
  return json(r.data, r.status, cors);
}

/* ---------- Muziekstatus op de achtergrond (v0.36) ----------
   Staat bij iemand Instellingen -> Muziekstatus -> \"Toon mijn muziek ook als ik offline ben\" aan (settings/<uid>.lastfm.bg = true), dan houdt
   deze functie (elke BG_EVERY_MIN minuten, vanuit de Cron Trigger) zijn muziekstatus bij, ook als Infinitum dicht is. Hij vraagt Last.fm,
   en schrijft users/<uid>.activity (met bg: true) en de luisterstatistiek users/<uid>.music (voor de muziekbadge).
   Onzichtbaar (presenceSettings) wordt gerespecteerd: dan wordt de muziek niet getoond.
   Gratis plan: max. 50 externe aanvragen per Cron-run, daarom BG_MAX mensen per run (gedraaid: bij meer mensen komt iedereen om de beurt aan de beurt).
   Kosten Firestore per persoon met bg aan: ca. 3 lezingen per run (instellingen, profiel, presence) en 1 schrijfactie per run zolang er muziek speelt. */
const BG_EVERY_MIN = 2;      // elke 2 minuten (zichtbaar bij anderen: max. ±2 min vertraging; een status wordt na 5,5 min als verlopen gezien)
const BG_MAX = 5;            // personen per run (5 x ~6 aanvragen blijft ruim onder de 50 van het gratis plan; met een betaald plan mag dit hoger)
const BG_BEAT = 100000;      // zelfde nummer blijft spelen: tijdstip verversen als het veld ouder is dan 100 s
const BG_CLEAR = 200000;     // niets meer aan het afspelen: pas wissen als het veld ouder is dan 200 s (twee keer niets gezien), anders flikkert het tussen nummers
const MUSIC_GAP = 300000;    // tijd tussen twee metingen waarbinnen het nog dezelfde luistersessie is (zelfde waarde als in js/lastfm.js)
const MUSIC_FLUSH = 60000;   // bij stoppen: hooguit zoveel luistertijd nog bijtellen

// luisterstatistiek bijwerken (zelfde rekenwijze als bump() in js/lastfm.js, en binnen wat firestore.rules toestaan)
function bumpMusic(m, key, now, stop) {
  const o = m && typeof m === 'object' ? m : {};
  const n = Number(o.n) || 0, ms = Number(o.ms) || 0, at = Number(o.at) || 0, gap = now - at;
  const cont = at > 0 && gap >= 0 && gap <= MUSIC_GAP;
  if (stop) return cont ? { n, ms: ms + Math.min(gap, MUSIC_FLUSH), at: now, lk: String(o.lk || '') } : { n, ms, at, lk: String(o.lk || '') };
  const fresh = !cont || String(o.lk || '') !== key;
  return { n: n + (fresh ? 1 : 0), ms: ms + (cont ? Math.min(gap, MUSIC_GAP) : 0), at: now, lk: key };
}
const typed = (v) => typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { booleanValue: v }
  : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : v && typeof v === 'object' ? { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, typed(x)])) } } : { nullValue: null };
// documenten lezen mét hun updateTime (voor de voorwaarde bij het schrijven); { pad: { d, ut } | null }
async function getDocsT(env, paths) {
  const r = await gFetch(env, `${FS}/projects/${pid(env)}/databases/(default)/documents:batchGet`, { method: 'POST', body: JSON.stringify({ documents: paths.map(p => docName(env, p)) }) });
  if (!r.ok) throw new Error('Firestore lezen mislukt (' + r.status + '): ' + (await r.text()).slice(0, 200));
  const by = {};
  for (const x of await r.json()) if (x.found) by[x.found.name] = { d: fromFields(x.found.fields), ut: x.found.updateTime };
  const out = {};
  for (const p of paths) out[p] = by[docName(env, p)] || null;
  return out;
}
// alleen `activity` en `music` van een profiel bijwerken; zonder `activity` in `fields` wordt het veld gewist. Mislukt (iemand was net eerder) = overslaan.
async function putMusic(env, uid, ut, fields) {
  const r = await gFetch(env, `${FS}/projects/${pid(env)}/databases/(default)/documents:commit`, { method: 'POST', body: JSON.stringify({ writes: [{
    update: { name: docName(env, 'users/' + uid), fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typed(v)])) },
    updateMask: { fieldPaths: ['activity', 'music'] },
    currentDocument: ut ? { updateTime: ut } : { exists: true }
  }] }) });
  if (r.ok) return true;
  const txt = (await r.text()).slice(0, 200);
  if (r.status === 409 || (r.status === 400 && /FAILED_PRECONDITION|ABORTED/.test(txt))) return false;   // iemand (de app zelf) was net eerder: deze ronde overslaan
  throw new Error('profiel schrijven mislukt (' + r.status + '): ' + txt);
}
async function pollMusic(env, event) {
  const slot = Math.floor((event && event.scheduledTime ? event.scheduledTime : Date.now()) / 60000);
  if (slot % BG_EVERY_MIN !== 0) return 0;
  if (!env.LASTFM_KEY) return 0;
  const q = await gFetch(env, `${FS}/projects/${pid(env)}/databases/(default)/documents:runQuery`, { method: 'POST', body: JSON.stringify({ structuredQuery: {
    from: [{ collectionId: 'settings' }],
    where: { fieldFilter: { field: { fieldPath: 'lastfm.bg' }, op: 'EQUAL', value: { booleanValue: true } } }, limit: 200 } }) });
  if (!q.ok) throw new Error('instellingen zoeken mislukt (' + q.status + '): ' + (await q.text()).slice(0, 200));
  const all = (await q.json()).filter(x => x.document).map(x => ({ uid: x.document.name.split('/').pop(), lfm: (fromFields(x.document.fields).lastfm) || {} }))
    .filter(x => x.lfm.bg === true && x.lfm.show !== false && LFM_RE.test(String(x.lfm.user || ''))).sort((a, b) => a.uid < b.uid ? -1 : 1);
  if (!all.length) return 0;
  const run = Math.floor(slot / BG_EVERY_MIN), take = Math.min(BG_MAX, all.length), start = (run * take) % all.length;
  const batch = Array.from({ length: take }, (_, i) => all[(start + i) % all.length]);
  const docs = await getDocsT(env, batch.flatMap(x => ['users/' + x.uid, 'presenceSettings/' + x.uid]));
  const now = Date.now(); let done = 0;
  for (const { uid, lfm } of batch) {
    try {
      const u = docs['users/' + uid]; if (!u) continue;
      const ps = docs['presenceSettings/' + uid] && docs['presenceSettings/' + uid].d, act = u.d.activity && u.d.activity.k === 'music' ? u.d.activity : null;
      const invisible = !!(ps && ps.mode === 'invisible' && (!ps.until || Number(ps.until) > now));
      const stat = u.d.music;
      if (invisible) {   // Onzichtbaar: niets tonen
        if (act) { await putMusic(env, uid, u.ut, stat ? { music: bumpMusic(stat, '', now, true) } : {}); done++; }
        continue;
      }
      const res = await lfmNow(env, lfm.user);
      if (!res.data.ok) {   // privé, bestaat niet, sleutel of Last.fm even weg: bij een blijvende fout de oude status laten verlopen
        if (act && ['nouser', 'private', 'badname'].includes(res.data.code)) { await putMusic(env, uid, u.ut, stat ? { music: bumpMusic(stat, '', now, true) } : {}); done++; }
        continue;
      }
      if (res.data.playing) {
        const t = res.data.title, a = res.data.artist, i = res.data.art && okArt(res.data.art) ? res.data.art : '';
        const same = act && act.t === t && act.a === a && String(act.i || '') === i && act.bg === true;
        if (same && now - (Number(act.at) || 0) < BG_BEAT) continue;   // niets nieuws (de app zelf was net al bezig)
        const na = { k: 'music', t, a, at: now, bg: true }; if (i) na.i = i;
        if (await putMusic(env, uid, u.ut, { activity: na, music: bumpMusic(stat, t + '|' + a, now, false) })) done++;
      } else if (act && now - (Number(act.at) || 0) >= BG_CLEAR) {
        if (await putMusic(env, uid, u.ut, stat ? { music: bumpMusic(stat, '', now, true) } : {})) done++;
      }
    } catch (e) { console.error('Muziek op de achtergrond mislukt voor ' + uid, e); }
  }
  return done;
}

const json = (obj, status, cors) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });

export default {
  // Cron Trigger (elke minuut): achtergebleven spraakdeelnemers opruimen, en (elke 2 min) de muziekstatus van wie die ook op de achtergrond wil
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweepVoice(env).catch(e => console.error('Spraak opruimen mislukt', e)));
    ctx.waitUntil(pollMusic(env, event).catch(e => console.error('Muziek op de achtergrond mislukt', e)));   // v0.36
  },
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname.startsWith('/m/')) return serveMedia(req, env, url);
    if (req.method === 'GET') return json({ ok: true, dienst: 'Infinitum push' }, 200, cors);
    if (req.method !== 'POST' || (url.pathname !== '/notify' && url.pathname !== '/upload' && url.pathname !== '/turn' && url.pathname !== '/lastfm')) return json({ ok: false, reason: 'niet gevonden' }, 404, cors);

    let uid;
    try { uid = await verifyIdToken(env, (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')); }
    catch (e) { return json({ ok: false, reason: 'Niet ingelogd: ' + e.message }, 401, cors); }

    if (url.pathname === '/upload') {
      try { return await upload(req, env, uid, url, cors); }
      catch (e) { console.error('Upload mislukt', e); return json({ ok: false, reason: 'Uploaden mislukt: ' + e.message }, 500, cors); }
    }

    if (url.pathname === '/lastfm') {
      try { return await lastfm(req, env, uid, cors); }
      catch (e) { console.error('Last.fm fout', e); return json({ ok: false, code: 'error', reason: 'Serverfout: ' + e.message }, 500, cors); }
    }

    if (url.pathname === '/turn') {
      try { return await turn(req, env, uid, url, cors); }
      catch (e) { console.error('TURN fout', e); return json({ ok: false, reason: 'Serverfout: ' + e.message }, 500, cors); }
    }

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