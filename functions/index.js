/* Infinitum: pushmeldingen via Firebase Cloud Messaging.
   Draait op Firebase (Blaze-abonnement nodig, de gratis hoeveelheid is ruim genoeg voor een kleine app).
   Let op: de regio hieronder moet bij de locatie van je Firestore-database passen
   (bijv. europe-west1 voor eur3 / europe-west1, us-central1 voor nam5 / us-central). */
const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });

// alleen tokens die echt niet meer bestaan worden verwijderd (bij andere fouten blijft het token staan)
const DEAD = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);
const clip = (t, n) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };

async function isDnd(uid) {
  const s = await db.doc(`presenceSettings/${uid}`).get();
  if (!s.exists) return false;
  const d = s.data();
  return d.mode === 'dnd' && (!d.until || d.until > Date.now());
}

// kind: 'dm' | 'server' | 'requests'  (zelfde namen als de meldingsinstellingen in de app)
async function push(uid, kind, { title, body, open, tag, force }) {
  if (!uid) return;
  const [set, dnd, toks] = await Promise.all([
    db.doc(`settings/${uid}`).get(),
    isDnd(uid),
    db.collection('pushTokens').where('uid', '==', uid).get()
  ]);
  if (dnd || toks.empty) return;
  // zit je op de pc (online, recente hartslag)? Dan geen push; de pc laat het zelf zien
  if (!force) {
    const pc = await db.doc(`presence/${uid}`).get();
    const d = pc.exists ? pc.data() : null;
    if (d && d.state === 'online' && d.lastSeen && Date.now() - d.lastSeen.toMillis() < 270000) return;
  }
  const n = { dm: true, server: true, requests: true, preview: true, ...((set.exists && set.data().notif) || {}) };
  if (n[kind] === false) return;

  const tokens = toks.docs.map(d => d.id);
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    // data-only: onze service worker (sw.js) toont de melding zelf
    data: { title: clip(title, 80), body: n.preview === false ? 'Nieuw bericht' : clip(body, 160), open: open || '', tag: tag || '', force: force ? '1' : '' },
    webpush: { headers: { Urgency: 'high', TTL: '86400' } },
    android: { priority: 'high' }
  });
  const dead = [];
  res.responses.forEach((r, i) => {
    if (r.success) return;
    console.warn('Push mislukt', uid, r.error?.code, r.error?.message);
    if (DEAD.has(r.error?.code)) dead.push(tokens[i]);
  });
  console.log(`Push naar ${uid} (${kind}): ${res.successCount}/${tokens.length} gelukt`);
  await Promise.all(dead.map(t => db.doc(`pushTokens/${t}`).delete().catch(() => {})));
}

// nieuw DM-bericht (chat-id = uidA_uidB)
exports.onDm = onDocumentCreated('chats/{chatId}/messages/{mid}', async (e) => {
  const m = e.data?.data(); if (!m) return;
  const others = e.params.chatId.split('_').filter(u => u && u !== m.uid);
  await Promise.all(others.map(u => push(u, 'dm', { title: m.name || 'Nieuw bericht', body: m.text, open: `dm:${e.params.chatId}`, tag: 'infinitum-dm' })));
});

// nieuw bericht in een server
exports.onServerMessage = onDocumentCreated('servers/{sid}/messages/{mid}', async (e) => {
  const m = e.data?.data(); if (!m) return;
  const srv = await db.doc(`servers/${e.params.sid}`).get();
  if (!srv.exists) return;
  const { name, members = [] } = srv.data();
  await Promise.all(members.filter(u => u !== m.uid).map(u =>
    push(u, 'server', { title: `${m.name || 'Iemand'} in ${name}`, body: m.text, open: `server:${e.params.sid}`, tag: 'infinitum-server' })));
});

// nieuw vriendschapsverzoek
exports.onFriendRequest = onDocumentCreated('friendships/{id}', async (e) => {
  const f = e.data?.data(); if (!f || f.status !== 'pending') return;
  const to = (f.users || []).find(u => u !== f.requester);
  await push(to, 'requests', { title: f.names?.[f.requester] || 'Nieuw verzoek', body: 'wil vrienden worden', open: 'requests', tag: 'infinitum-requests' });
});

// meldingen uit de inbox (besluiten van moderators, profielwijzigingen...)
exports.onInbox = onDocumentCreated('notifications/{nid}', async (e) => {
  const n = e.data?.data(); if (!n || n.type === 'sub_request') return;
  await push(n.uid, 'requests', { title: n.title || 'Melding', body: n.text, open: 'inbox', tag: 'infinitum-requests' });
});

// nieuwe abonnementsaanvraag -> alle moderators
exports.onSubscriptionRequest = onDocumentWritten('subscriptions/{uid}', async (e) => {
  const after = e.data?.after?.data(), before = e.data?.before?.data();
  if (!after || after.status !== 'pending' || before?.status === 'pending') return;
  const badge = await db.doc('badges/moderator').get();
  const mods = ((badge.exists && badge.data().users) || []).filter(u => u !== e.params.uid);
  await Promise.all(mods.map(u => push(u, 'requests', { title: after.username || 'Iemand', body: `vraagt ${after.tier === 'prime' ? 'Infinitum Prime' : 'Infinitum+'} aan`, open: 'admin', tag: 'infinitum-requests' })));
});

// "Testpush via de server" in de instellingen: schrijft pushTests/<uid>; wij sturen na 5 sec een melding (ook als de app open is)
exports.onPushTest = onDocumentWritten('pushTests/{uid}', async (e) => {
  if (!e.data?.after?.exists) return;
  await new Promise(r => setTimeout(r, 5000));
  await push(e.params.uid, 'dm', { title: 'Infinitum testpush', body: 'Werkt! Zo komen echte meldingen binnen.', open: '', tag: 'infinitum-test', force: true });
});
