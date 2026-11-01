import { auth, db, googleProvider } from './firebase.js';
import {
  onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, signInWithRedirect, signOut
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { collection, doc, getDoc, getDocs, writeBatch, serverTimestamp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';

const $ = (sel) => document.querySelector(sel);
const TIERS = {
  free:  { name: 'Infinitum',       icon: 'assets/favicon.svg' },
  plus:  { name: 'Infinitum+',      icon: 'assets/favicon-plus.svg' },
  prime: { name: 'Infinitum Prime', icon: 'assets/favicon-prime.svg' }
};
const PAID = ['plus', 'prime'];
const tierKey = (p) => (p && PAID.includes(p.tier) ? p.tier : 'free');

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

function fbErr(e) {
  const c = e?.code || '';
  if (c.includes('permission-denied')) return 'Dit mocht niet (permission-denied). Controleer of de nieuwste firestore.rules zijn gepubliceerd.';
  if (c.includes('unavailable')) return 'Geen verbinding met Firebase.';
  return (e?.message || 'Er ging iets mis.') + (c ? ` (${c})` : '');
}
function authErr(e) {
  switch (e?.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found': return 'Onjuiste e-mail of wachtwoord.';
    case 'auth/invalid-email': return 'Dit e-mailadres klopt niet.';
    case 'auth/too-many-requests': return 'Te veel pogingen. Probeer het later opnieuw.';
    case 'auth/unauthorized-domain': return `Het domein "${location.hostname}" staat niet bij de toegestane domeinen in Firebase.`;
    case 'auth/network-request-failed': return 'Netwerkfout — controleer je internetverbinding.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request': return '';
    default: return fbErr(e);
  }
}

const show = (id) => {
  for (const s of ['stLoad', 'stLogin', 'stNoProfile', 'stForm', 'stDone']) $('#' + s).hidden = s !== id;
};

/* ---------- inloggen ---------- */
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#lErr'), btn = $('#lSubmit');
  err.textContent = '';
  const mail = $('#lMail').value.trim(), pass = $('#lPass').value;
  if (!mail || !pass) { err.textContent = 'Vul je e-mail en wachtwoord in.'; return; }
  btn.disabled = true;
  try { await signInWithEmailAndPassword(auth, mail, pass); }
  catch (ex) { err.textContent = authErr(ex); }
  finally { btn.disabled = false; }
});
$('#lGoogle').addEventListener('click', async () => {
  $('#lErr').textContent = '';
  try { await signInWithPopup(auth, googleProvider); }
  catch (ex) {
    if (ex.code === 'auth/popup-blocked') { try { await signInWithRedirect(auth, googleProvider); return; } catch (e2) { ex = e2; } }
    $('#lErr').textContent = authErr(ex);
  }
});
$('#logoutBtn').addEventListener('click', () => signOut(auth));

/* ---------- formulier ---------- */
const params = new URLSearchParams(location.search);
let me = null, profile = null, features = [], prices = {}, chosen = PAID.includes(params.get('tier')) ? params.get('tier') : 'plus';
let busy = false;

const featSort = (a, b) => (Number.isFinite(+a.order) ? +a.order : 999) - (Number.isFinite(+b.order) ? +b.order : 999) || String(a.name).localeCompare(String(b.name));
const inc = (v) => v === true || (typeof v === 'string' && v.trim());

async function loadData(uid) {
  profile = null; features = []; prices = {};
  const [p, f, pl, sub] = await Promise.all([
    getDoc(doc(db, 'users', uid)),
    getDocs(collection(db, 'features')).catch(() => null),
    getDoc(doc(db, 'config', 'plans')).catch(() => null),
    getDoc(doc(db, 'subscriptions', uid)).catch(() => null)
  ]);
  profile = p.exists() ? p.data() : null;
  features = f ? f.docs.map(d => ({ id: d.id, ...d.data() })).filter(x => x.name).sort(featSort) : [];
  prices = pl?.exists() ? pl.data() : {};
  return sub?.exists() ? sub.data() : null;
}

function renderPlans() {
  const mine = tierKey(profile), box = $('#plans');
  if (mine === chosen) chosen = PAID.find(t => t !== mine) || chosen;
  box.replaceChildren(...PAID.map(t => {
    const off = mine === t;
    const input = h('input', { type: 'radio', name: 'tier', value: t, disabled: off });
    input.checked = chosen === t;
    input.addEventListener('change', () => { chosen = t; renderFeats(); });
    const list = features.filter(f => inc(f[t]) && !inc(f.free));
    return h('label', { class: 'up-plan' + (off ? ' off' : '') }, input,
      h('span', { class: 'ph' }, h('img', { src: TIERS[t].icon, alt: '' }),
        h('span', {}, h('b', { text: TIERS[t].name }), h('br'), h('small', { text: off ? 'Dit heb je al' : String(prices[t + 'Price'] || '') }))),
      list.length ? h('ul', {}, list.slice(0, 6).map(f => h('li', { text: f.name + (typeof f[t] === 'string' ? ` (${f[t]})` : '') }))) : null);
  }));
  renderFeats();
}

let picked = new Set();
function renderFeats() {
  const box = $('#feats');
  const list = features.filter(f => inc(f[chosen]) && !inc(f.free));
  if (!list.length) { box.replaceChildren(h('p', { class: 'hint', text: 'Geen functies om uit te kiezen.' })); return; }
  box.replaceChildren(...list.map(f => {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = picked.has(f.name);
    cb.addEventListener('change', () => { cb.checked ? picked.add(f.name) : picked.delete(f.name); });
    return h('label', { class: 'up-check' }, cb, h('span', { text: f.name }));
  }));
}

function renderExisting(sub) {
  const box = $('#existing');
  box.replaceChildren();
  if (!sub) return;
  const name = TIERS[sub.tier]?.name || 'een abonnement';
  if (sub.status === 'pending') box.append(h('p', { class: 'up-info pend', text: `Je hebt al een aanvraag voor ${name} openstaan. Als je dit formulier verstuurt, vervangt het die aanvraag.` }));
  else if (sub.status === 'rejected') box.append(h('p', { class: 'up-info bad', text: `Je vorige aanvraag voor ${name} is afgewezen.` + (sub.note ? ` Bericht van de moderator: ${sub.note}` : '') }));
}

$('#reason').addEventListener('input', () => { $('#reasonCount').textContent = `${$('#reason').value.length}/500`; });

$('#upForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy || !me) return;
  const err = $('#fErr'); err.textContent = '';
  const reason = $('#reason').value.trim();
  if (tierKey(profile) === chosen) { err.textContent = 'Dit abonnement heb je al.'; return; }
  if (reason.length < 10) { err.textContent = 'Vertel iets meer over waarom je wilt upgraden (minimaal 10 tekens).'; return; }
  if (!$('#agree').checked) { err.textContent = 'Vink aan dat je begrijpt hoe de aanvraag werkt.'; return; }
  busy = true; $('#fSubmit').disabled = true;
  try {
    const batch = writeBatch(db);
    const name = String(profile?.username || 'Onbekend').slice(0, 20);
    batch.set(doc(db, 'subscriptions', me.uid), {
      username: name,
      tier: chosen, status: 'pending', requestedAt: serverTimestamp(),
      form: {
        reason: reason.slice(0, 500),
        features: [...picked].map(x => String(x).slice(0, 60)).slice(0, 12),
        extra: $('#extra').value.trim().slice(0, 300)
      }
    });
    batch.set(doc(collection(db, 'notifications')), {
      uid: me.uid, type: 'sub_request', title: `Aanvraag voor ${TIERS[chosen].name} verstuurd`,
      text: 'Je aanvraag is bij de moderators aangekomen. Zodra hij is beoordeeld, krijg je hier een melding met hun reactie.',
      by: me.uid, byName: name, createdAt: serverTimestamp(), read: false
    });
    await batch.commit();
    $('#doneText').textContent = `Je aanvraag voor ${TIERS[chosen].name} is bij de moderators aangekomen. Je krijgt een melding in Infinitum zodra hij is beoordeeld.`;
    show('stDone');
  } catch (ex) { err.textContent = fbErr(ex); }
  finally { busy = false; $('#fSubmit').disabled = false; }
});

onAuthStateChanged(auth, async (user) => {
  me = user;
  if (!user) { show('stLogin'); return; }
  show('stLoad');
  try {
    const sub = await loadData(user.uid);
    if (!profile) { show('stNoProfile'); return; }
    $('#whoName').textContent = profile.username || '';
    renderExisting(sub); renderPlans();
    show('stForm');
  } catch (e) {
    show('stLogin'); $('#lErr').textContent = fbErr(e);
  }
});
