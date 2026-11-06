import { auth, db, googleProvider, PUSH_URL } from './firebase.js?v=0.11';
import {
  onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, signInWithRedirect, signOut
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { collection, doc, getDoc, getDocs, deleteDoc, onSnapshot, writeBatch, serverTimestamp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';

const $ = (sel) => document.querySelector(sel);

// Vraagt de push-dienst (Cloudflare Worker) de moderators te waarschuwen. Mislukt dit, dan merkt de gebruiker er niets van.
async function pushPing(payload) {
  if (!PUSH_URL || !auth.currentUser) return;
  try {
    const idt = await auth.currentUser.getIdToken();
    await fetch(PUSH_URL.replace(/\/$/, '') + '/notify', {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idt },
      body: JSON.stringify(payload)
    });
  } catch (e) { console.warn('Pushmelding aanvragen mislukt:', e); }
}
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

/* ---------- aanvraag: voorwaarden, formulier en voortgang ---------- */
// Let op: deze getallen staan ook in firestore.rules (7 dagen account, 7 dagen wachttijd, 40 tekens).
const MIN_AGE_DAYS = 7, COOLDOWN_DAYS = 7, MIN_REASON = 40, DAY = 864e5;
const PURPOSES = {
  server:  'Eigen servers beheren en uitbreiden',
  style:   'Mijn profiel en achtergrond persoonlijker maken',
  try:     'De extra functies uitproberen',
  support: 'Infinitum steunen en helpen verbeteren',
  other:   'Iets anders (leg uit bij de opmerking)'
};
const params = new URLSearchParams(location.search);
let me = null, profile = null, features = [], prices = {}, sub = null, unsubSub = null;
let chosen = PAID.includes(params.get('tier')) ? params.get('tier') : 'plus';
let purpose = '', busy = false;
const picked = new Set();

const featSort = (a, b) => (Number.isFinite(+a.order) ? +a.order : 999) - (Number.isFinite(+b.order) ? +b.order : 999) || String(a.name).localeCompare(String(b.name));
const inc = (v) => v === true || (typeof v === 'string' && v.trim());
const fmtDate = (ms) => new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(ms));
const daysLeft = (ms) => Math.max(1, Math.ceil(ms / DAY));

async function loadProfile(uid) {
  const p = await getDoc(doc(db, 'users', uid));
  profile = p.exists() ? p.data() : null;
}
async function loadData(uid) {
  features = []; prices = {};
  const [, f, pl] = await Promise.all([
    loadProfile(uid),
    getDocs(collection(db, 'features')).catch(() => null),
    getDoc(doc(db, 'config', 'plans')).catch(() => null)
  ]);
  features = f ? f.docs.map(d => ({ id: d.id, ...d.data() })).filter(x => x.name).sort(featSort) : [];
  prices = pl?.exists() ? pl.data() : {};
}

/* voorwaarden (de belangrijkste worden ook door Firestore afgedwongen) */
function eligibility() {
  const created = profile?.createdAt?.toMillis?.() || 0;
  const ageMs = created ? Date.now() - created : Infinity;
  const ageOk = ageMs >= MIN_AGE_DAYS * DAY;
  const profOk = !!(String(profile?.bio || '').trim() || String(profile?.avatar || '').trim());
  const open = sub?.status === 'pending';
  const cdLeft = sub?.status === 'rejected' ? (sub.decidedAt?.toMillis?.() || 0) + COOLDOWN_DAYS * DAY - Date.now() : 0;
  return { ageOk, ageLeft: ageOk ? 0 : MIN_AGE_DAYS * DAY - ageMs, profOk, open, cdLeft: Math.max(0, cdLeft), ok: ageOk && profOk && !open && cdLeft <= 0 };
}
function renderChecks() {
  const e = eligibility();
  const row = (ok, text, hint) => h('li', { class: 'up-chk ' + (ok ? 'ok' : 'no') },
    h('span', { class: 'up-chk-ic', text: ok ? '✓' : '✗', 'aria-hidden': 'true' }),
    h('span', {}, text, hint ? h('small', { text: hint }) : null));
  $('#checks').replaceChildren(
    row(e.ageOk, `Je account is minstens ${MIN_AGE_DAYS} dagen oud`, e.ageOk ? '' : `Nog ${daysLeft(e.ageLeft)} dag${daysLeft(e.ageLeft) === 1 ? '' : 'en'} te gaan.`),
    row(e.profOk, 'Je profiel is ingevuld (een bio of een profielfoto)', e.profOk ? '' : 'Vul dit in via je profiel in Infinitum.'),
    row(!e.open, 'Je hebt geen aanvraag openstaan', e.open ? 'Wacht tot je huidige aanvraag is beoordeeld.' : ''),
    row(e.cdLeft <= 0, 'Je vorige aanvraag is niet recent afgewezen', e.cdLeft > 0 ? `Je kunt opnieuw aanvragen over ${daysLeft(e.cdLeft)} dag${daysLeft(e.cdLeft) === 1 ? '' : 'en'}.` : ''));
  return e;
}

/* voortgang van een lopende (of net beoordeelde) aanvraag */
function trackSteps(s) {
  const by = s.step1?.byName ? `moderator ${s.step1.byName}` : 'een moderator';
  if (s.status === 'pending') return [
    { st: 'done', t: 'Ingediend', d: 'Je aanvraag is bij de moderators aangekomen.' },
    s.step1 ? { st: 'done', t: 'Eerste moderator', d: `Goedgekeurd door ${by}.` } : { st: 'cur', t: 'Eerste moderator', d: 'Wacht op beoordeling.' },
    s.step1 ? { st: 'cur', t: 'Tweede moderator', d: 'Nu kijkt een tweede moderator mee. Hij moet ook goedkeuren.' } : { st: 'todo', t: 'Tweede moderator', d: 'Een andere moderator kijkt daarna mee.' },
    { st: 'todo', t: 'Besluit', d: 'Je krijgt een melding in Infinitum.' }
  ];
  if (s.status === 'rejected') return [
    { st: 'done', t: 'Ingediend', d: '' },
    s.step1 ? { st: 'done', t: 'Eerste moderator', d: `Goedgekeurd door ${by}.` } : { st: 'bad', t: 'Eerste moderator', d: 'Afgewezen.' },
    s.step1 ? { st: 'bad', t: 'Tweede moderator', d: 'Afgewezen.' } : { st: 'todo', t: 'Tweede moderator', d: '' },
    { st: 'bad', t: 'Besluit', d: 'Je aanvraag is afgewezen.' }
  ];
  return [
    { st: 'done', t: 'Ingediend', d: '' }, { st: 'done', t: 'Eerste moderator', d: s.step1 ? `Goedgekeurd door ${by}.` : '' },
    { st: 'done', t: 'Tweede moderator', d: 'Goedgekeurd.' }, { st: 'done', t: 'Besluit', d: 'Je abonnement is geactiveerd.' }
  ];
}
function renderTrack() {
  const box = $('#track');
  box.replaceChildren();
  if (!sub || !sub.tier || sub.tier === 'free') return;
  const mine = tierKey(profile);
  const showApproved = sub.status === 'approved' && sub.step1 && mine === sub.tier;
  if (sub.status !== 'pending' && sub.status !== 'rejected' && !showApproved) return;
  const name = TIERS[sub.tier]?.name || 'een abonnement';
  const e = eligibility();
  const title = sub.status === 'pending' ? `Je aanvraag voor ${name}` : sub.status === 'rejected' ? `Je aanvraag voor ${name} is afgewezen` : `${name} is geactiveerd`;
  const list = h('ol', { class: 'up-steps' }, trackSteps(sub).map((x, i) =>
    h('li', { class: 'up-step ' + x.st },
      h('span', { class: 'up-dot', text: x.st === 'done' ? '✓' : x.st === 'bad' ? '✗' : String(i + 1), 'aria-hidden': 'true' }),
      h('span', {}, h('b', { text: x.t }), x.d ? h('small', { text: x.d }) : null))));
  const kids = [h('h2', { class: 'up-h', text: title }), list];
  if (sub.status === 'pending' && sub.step1?.note) kids.push(h('p', { class: 'up-info', text: `Bericht van de eerste moderator: ${sub.step1.note}` }));
  if (sub.status !== 'pending' && sub.note) kids.push(h('p', { class: 'up-info ' + (sub.status === 'rejected' ? 'bad' : ''), text: `Reden van de moderator: ${sub.note}` }));
  if (sub.status === 'rejected') kids.push(h('p', { class: 'up-info', text: e.cdLeft > 0 ? `Je kunt opnieuw aanvragen op ${fmtDate(Date.now() + e.cdLeft)}. Gebruik de tijd om je profiel aan te vullen.` : 'Je mag nu opnieuw aanvragen. Pas je aanvraag aan op de reden hierboven.' }));
  if (sub.status === 'pending') {
    const btn = h('button', { class: 'ghost', type: 'button', text: 'Aanvraag intrekken' });
    btn.addEventListener('click', async () => {
      if (!confirm('Weet je zeker dat je je aanvraag wilt intrekken? De beoordeling tot nu toe gaat verloren.')) return;
      btn.disabled = true;
      try { await deleteDoc(doc(db, 'subscriptions', me.uid)); } catch (ex) { btn.disabled = false; alert(fbErr(ex)); }
    });
    kids.push(h('div', { class: 'up-actions' }, btn));
  }
  box.append(...kids);
}

/* abonnementskeuze + functies */
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
function renderPurposes() {
  $('#purposes').replaceChildren(...Object.entries(PURPOSES).map(([k, t]) => {
    const input = h('input', { type: 'radio', name: 'purpose', value: k });
    input.checked = purpose === k;
    input.addEventListener('change', () => { purpose = k; });
    return h('label', { class: 'up-check' }, input, h('span', { text: t }));
  }));
}

function renderAll() {
  if (!me || !profile) return;
  const e = renderChecks();
  renderTrack(); renderPlans();
  $('#formWrap').hidden = e.open;                 // tijdens een lopende aanvraag toon je alleen de voortgang
  $('#upFields').disabled = !e.ok;
  $('#fSubmit').disabled = !e.ok || busy;
  $('#fSubmit').textContent = e.ok ? 'Aanvraag versturen' : 'Je voldoet nog niet aan alle voorwaarden';
}

function updateCounts() {
  const n = $('#reason').value.trim().length;
  $('#reasonCount').textContent = `${n}/500${n < MIN_REASON ? ` · nog minstens ${MIN_REASON - n} tekens` : ''}`;
}
$('#reason').addEventListener('input', updateCounts);

$('#upForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (busy || !me) return;
  const err = $('#fErr'); err.textContent = '';
  const e = eligibility();
  const reason = $('#reason').value.trim(), extra = $('#extra').value.trim();
  if (!e.ok) { err.textContent = 'Je voldoet nog niet aan alle voorwaarden hierboven.'; return; }
  if (tierKey(profile) === chosen) { err.textContent = 'Dit abonnement heb je al.'; return; }
  if (!purpose) { err.textContent = 'Kies waar je de upgrade vooral voor wilt gebruiken.'; return; }
  if (reason.length < MIN_REASON) { err.textContent = `Leg wat uitgebreider uit waarom je wilt upgraden (minimaal ${MIN_REASON} tekens).`; return; }
  if (purpose === 'other' && extra.length < 10) { err.textContent = 'Je koos "iets anders": leg dat uit bij de opmerking (minimaal 10 tekens).'; return; }
  if (!$('#agreeRules').checked || !$('#agreeFlow').checked) { err.textContent = 'Vink beide vakjes onderaan aan om door te gaan.'; return; }
  busy = true; renderAll();
  try {
    const batch = writeBatch(db);
    const name = String(profile?.username || 'Onbekend').slice(0, 20);
    batch.set(doc(db, 'subscriptions', me.uid), {
      username: name, tier: chosen, status: 'pending', requestedAt: serverTimestamp(),
      form: {
        reason: reason.slice(0, 500), purpose,
        features: [...picked].map(x => String(x).slice(0, 60)).slice(0, 12),
        extra: extra.slice(0, 300), rules: true
      }
    });
    batch.set(doc(collection(db, 'notifications')), {
      uid: me.uid, type: 'sub_request', title: `Aanvraag voor ${TIERS[chosen].name} verstuurd`,
      text: 'Je aanvraag wordt door twee moderators beoordeeld. Je krijgt een melding na elke stap.',
      by: me.uid, byName: name, createdAt: serverTimestamp(), read: false
    });
    await batch.commit();
    pushPing({ type: 'sub' });
    $('#doneText').textContent = `Je aanvraag voor ${TIERS[chosen].name} is verstuurd. Twee verschillende moderators beoordelen hem na elkaar. Je krijgt na elke stap een melding, en je kunt de voortgang hier volgen.`;
    $('#reason').value = ''; $('#extra').value = ''; $('#agreeRules').checked = false; $('#agreeFlow').checked = false;
    purpose = ''; picked.clear(); renderPurposes(); updateCounts();
    show('stDone');
  } catch (ex) { err.textContent = fbErr(ex); }
  finally { busy = false; renderAll(); }
});
$('#doneBack').addEventListener('click', () => show('stForm'));

onAuthStateChanged(auth, async (user) => {
  me = user;
  unsubSub?.(); unsubSub = null; sub = null;
  if (!user) { show('stLogin'); return; }
  show('stLoad');
  try {
    await loadData(user.uid);
    if (!profile) { show('stNoProfile'); return; }
    $('#whoName').textContent = profile.username || '';
    renderPurposes(); updateCounts();
    // live meekijken: zodra een moderator iets beslist, ververst de voortgang vanzelf
    unsubSub = onSnapshot(doc(db, 'subscriptions', user.uid), async (s) => {
      sub = s.exists() ? s.data({ serverTimestamps: 'estimate' }) : null;
      if (sub?.status === 'approved') { try { await loadProfile(user.uid); } catch (e) { /* niet erg */ } }
      renderAll();
    }, (ex) => { $('#fErr').textContent = fbErr(ex); renderAll(); });
    renderAll();
    show('stForm');
  } catch (e) {
    show('stLogin'); $('#lErr').textContent = fbErr(e);
  }
});
