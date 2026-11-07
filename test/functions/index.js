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

// kind: 'dm' | 'server' | 'mention' | 'requests'  (zelfde namen als de meldingsinstellingen in de app)
async function push(uid, kind, { title, body, open, tag, force }) {
  if (!uid) return;
  const [set, dnd, toks] = await Promise.all([
    db.doc(`settings/${uid}`).get(),
    isDnd(uid),
    db.collection('pushTokens').where('uid', '==', uid).get()
  ]);
  if (dnd || toks.empty) { console.log(`Push naar ${uid} overgeslagen: dnd=${dnd}, tokens=${toks.size}`); return; }
  const n = { dm: true, server: true, mention: true, requests: true, preview: true, pcQuiet: true, ...((set.exists && set.data().notif) || {}) };
  // zit je op de pc (online of inactief, recente hartslag)? Dan geen push naar de telefoon; de pc laat het zelf zien.
  // Instelbaar: Instellingen -> Meldingen -> "Geen meldingen op telefoon als je op de pc zit".
  if (!force && n.pcQuiet !== false) {
    const pc = await db.doc(`presence/${uid}`).get();
    const d = pc.exists ? pc.data() : null;
    if (d && d.lastSeen && ((d.state === 'online' && Date.now() - d.lastSeen.toMillis() < 270000) || (d.state === 'idle' && Date.now() - d.lastSeen.toMillis() < 480000))) return;
  }
  // v0.12: zit je zelf in de app op je telefoon (online, verse hartslag)? Dan toont de app de melding zelf; geen push erbij.
  // (Op iPhone toont de service worker een push altijd, ook als de app openstaat; daarom sturen we hem dan helemaal niet.)
  if (!force) {
    const ph = await db.doc(`presence/${uid}_m`).get();
    const d = ph.exists ? ph.data() : null;
    if (d && d.state === 'online' && d.lastSeen && Date.now() - d.lastSeen.toMillis() < 100000) { console.log(`Push naar ${uid} overgeslagen: zit in de app op de telefoon`); return; }
  }
  if (n[kind] === false) { console.log(`Push naar ${uid} overgeslagen: ${kind} staat uit`); return; }

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
  console.log('onDm', e.params.chatId);
  const others = e.params.chatId.split('_').filter(u => u && u !== m.uid);
  await Promise.all(others.map(u => push(u, 'dm', { title: m.name || 'Nieuw bericht', body: m.text, open: `dm:${e.params.chatId}`, tag: 'infinitum-dm' })));
});

// ---------- servers: kanalen, rollen en mentions ----------
// Zelfde rechtenlogica als firestore.rules / de app: eigenaar (officiële server: moderator) kan alles, anderen via rollen (permIdx + mroles).
async function modUids() {
  const [a, b] = await Promise.all([db.doc('badges/moderator').get(), db.doc('badges/admin').get()]);
  return new Set([...((a.exists && a.data().users) || []), ...((b.exists && b.data().users) || [])]);
}
const roleIds = (srv, uid) => [...((srv.mroles && srv.mroles[uid]) || []), 'everyone'];
const hasPerm = (srv, mods, uid, p) => (srv.official ? mods.has(uid) : srv.ownerId === uid)
  || roleIds(srv, uid).some(r => ((srv.permIdx || {})[p] || []).includes(r) || ((srv.permIdx || {}).admin || []).includes(r));
const aclHit = (srv, uid, list) => (list || []).some(t => t === 'everyone' || t === 'u:' + uid || roleIds(srv, uid).includes(t));
const canView = (srv, mods, ch, uid) => hasPerm(srv, mods, uid, 'admin') || !(ch.acl && ch.acl.view) || aclHit(srv, uid, ch.acl.view);

async function serverMessage(sid, cid, m, mid) {
  const srvSnap = await db.doc(`servers/${sid}`).get();
  if (!srvSnap.exists) return;
  const srv = srvSnap.data(), members = srv.members || [];
  const chSnap = await db.doc(`servers/${sid}/channels/${cid}`).get();
  if (cid !== 'general' && !chSnap.exists) return;
  const ch = chSnap.exists ? chSnap.data() : { name: 'algemeen' };
  const mods = await modUids();
  const viewers = new Set(members.filter(u => u !== m.uid && canView(srv, mods, ch, u)));

  // wie is getagd? (rechten om @everyone / rollen te gebruiken zijn al door de beveiligingsregels gecontroleerd)
  const mn = m.mentions || {}, mentioned = new Set();
  for (const u of mn.users || []) if (viewers.has(u)) mentioned.add(u);
  if (mn.everyone) viewers.forEach(u => mentioned.add(u));
  for (const rid of mn.roles || []) for (const u of viewers) if (((srv.mroles || {})[u] || []).includes(rid)) mentioned.add(u);

  console.log(`serverMessage ${sid}/${cid}: ${viewers.size} kijkers, ${mentioned.size} getagd (everyone=${!!mn.everyone}, rollen=${(mn.roles || []).length}, users=${(mn.users || []).length})`);
  const open = `server:${sid}:${cid}`, where = `${srv.name} #${ch.name}`;
  const list = [...mentioned].slice(0, 500);
  // Vermeldingen komen niet meer in de inbox (de bel): de app toont ze als teller bij Servers -> server -> kanaal. Alleen de push blijft.
  await Promise.all(list.map(u => push(u, 'mention', { title: `${m.name || 'Iemand'} noemde je in ${where}`, body: m.text, open, tag: 'infinitum-mention' })));

  // gewone berichten: alleen niet-officiële servers melden alles; de officiële server alleen bij mentions
  if (srv.official) return;
  const rest = [...viewers].filter(u => !mentioned.has(u)).slice(0, 500);
  await Promise.all(rest.map(u => push(u, 'server', { title: `${m.name || 'Iemand'} in ${where}`, body: m.text, open, tag: 'infinitum-server' })));
}

// nieuw bericht in kanaal #algemeen (oude plek) of in een ander kanaal
exports.onServerMessage = onDocumentCreated('servers/{sid}/messages/{mid}', async (e) => {
  const m = e.data?.data(); if (!m) return;
  console.log('onServerMessage', e.params.sid);
  await serverMessage(e.params.sid, 'general', m, e.params.mid);
});
exports.onChannelMessage = onDocumentCreated('servers/{sid}/channels/{cid}/messages/{mid}', async (e) => {
  const m = e.data?.data(); if (!m) return;
  console.log('onChannelMessage', e.params.sid, e.params.cid);
  await serverMessage(e.params.sid, e.params.cid, m, e.params.mid);
});

// nieuw vriendschapsverzoek
exports.onFriendRequest = onDocumentCreated('friendships/{id}', async (e) => {
  const f = e.data?.data(); if (!f || f.status !== 'pending') return;
  const to = (f.users || []).find(u => u !== f.requester);
  await push(to, 'requests', { title: f.names?.[f.requester] || 'Nieuw verzoek', body: 'wil vrienden worden', open: 'requests', tag: 'infinitum-requests' });
});

// meldingen uit de inbox (besluiten van moderators, profielwijzigingen...)
exports.onInbox = onDocumentCreated('notifications/{nid}', async (e) => {
  const n = e.data?.data(); if (!n || n.type === 'sub_request' || n.type === 'mention') return;
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
  console.log('onPushTest gestart voor', e.params.uid);
  await new Promise(r => setTimeout(r, 5000));
  await push(e.params.uid, 'dm', { title: 'Infinitum testpush', body: 'Werkt! Zo komen echte meldingen binnen.', open: '', tag: 'infinitum-test', force: true });
});


/* ---------- account verwijderd: de rest opruimen ----------
   De app verwijdert zelf profiel, gebruikersnaam en instellingen en daarna het inlogaccount (Instellingen -> Account).
   Zodra het inlogaccount weg is, ruimt deze functie de rest op: berichten, vriendschappen (met hun DM's), servers en meldingen. */
const functionsV1 = require('firebase-functions/v1');

async function deleteQuery(q) {
  for (;;) {
    const snap = await q.limit(400).get();
    if (snap.empty) return;
    const b = db.batch();
    snap.docs.forEach(d => b.delete(d.ref));
    await b.commit();
    if (snap.size < 400) return;
  }
}
const safely = async (label, fn) => { try { await fn(); } catch (e) { console.error('Opruimen mislukt:', label, e); } };

exports.cleanupDeletedUser = functionsV1.region('europe-west1').auth.user().onDelete(async (user) => {
  const uid = user.uid;
  console.log('Account verwijderd, opruimen:', uid);

  await safely('profiel', async () => {
    const u = await db.doc(`users/${uid}`).get();
    const lower = u.exists ? u.data().usernameLower : null;
    if (lower) { const n = await db.doc(`usernames/${lower}`).get(); if (n.exists && n.data().uid === uid) await n.ref.delete(); }
    await db.doc(`users/${uid}`).delete();
  });
  await safely('losse documenten', () => Promise.all([
    db.doc(`settings/${uid}`).delete(), db.doc(`presence/${uid}`).delete(), db.doc(`presence/${uid}_m`).delete(),
    db.doc(`presenceSettings/${uid}`).delete(), db.doc(`subscriptions/${uid}`).delete(), db.doc(`pushTests/${uid}`).delete(),
    db.recursiveDelete(db.collection(`sessions/${uid}/devices`))
  ]));
  await safely('pushtokens', () => deleteQuery(db.collection('pushTokens').where('uid', '==', uid)));
  await safely('meldingen', () => deleteQuery(db.collection('notifications').where('uid', '==', uid)));

  // vriendschappen: de hele DM-chat gaat mee
  await safely('vriendschappen', async () => {
    const fr = await db.collection('friendships').where('users', 'array-contains', uid).get();
    for (const f of fr.docs) {
      await safely('dm ' + f.id, () => db.recursiveDelete(db.doc(`chats/${f.id}`)));
      await f.ref.delete();
    }
  });

  // servers: eigen servers (behalve de officiële) verwijderen; in andere servers lidmaatschap, rollen en eigen berichten opruimen
  await safely('servers', async () => {
    const sv = await db.collection('servers').where('members', 'array-contains', uid).get();
    for (const s of sv.docs) {
      const d = s.data();
      if (d.ownerId === uid && s.id !== 'official') { await safely('server ' + s.id, () => db.recursiveDelete(s.ref)); continue; }
      await safely('server ' + s.id, async () => {
        await deleteQuery(s.ref.collection('messages').where('uid', '==', uid));
        const ch = await s.ref.collection('channels').get();
        for (const c of ch.docs) await deleteQuery(c.ref.collection('messages').where('uid', '==', uid));
        await Promise.all([s.ref.collection('typing').doc(uid).delete(), s.ref.collection('reads').doc(uid).delete()]);
        await s.ref.update({ members: admin.firestore.FieldValue.arrayRemove(uid), [`mroles.${uid}`]: admin.firestore.FieldValue.delete() });
      });
    }
  });
  console.log('Opruimen klaar:', uid);
});
