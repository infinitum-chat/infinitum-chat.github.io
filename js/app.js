import { app as fbApp, auth, db, googleProvider, VAPID_KEY, PUSH_URL, getMessaging, getToken, deleteToken, pushSupported } from './firebase.js?v=0.7';
import {
  onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signInWithPopup, signInWithRedirect, signOut
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import {
  collection, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, query, where, orderBy,
  limit, onSnapshot, serverTimestamp, writeBatch, arrayUnion, arrayRemove, deleteField, Timestamp
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';

const APP_VERSION = 'v0.7';
const IS_MOBILE = matchMedia('(hover: none) and (pointer: coarse)').matches;
document.querySelectorAll('.app-ver').forEach(el => { el.textContent = 'Infinitum ' + APP_VERSION; });

/* =====================  webapp: service worker, schermhoogte, installeren  ===================== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker:', e)));
}
// echte zichtbare hoogte (ook als op de telefoon het toetsenbord omhoog komt)
{
  const vv = window.visualViewport;
  // De app vult normaal gewoon het hele scherm (CSS). Alleen als het toetsenbord open is, krimpt hij mee met het zichtbare vak.
  let base = 0;
  const editing = () => { const a = document.activeElement; return !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); };
  const fit = () => {
    const r = document.documentElement, hgt = vv ? vv.height : innerHeight;
    base = Math.max(base, hgt, innerHeight);
    const kb = editing() && base - hgt > 120;
    r.dataset.kb = kb ? '1' : '';
    r.style.setProperty('--app-h', hgt + 'px');
    r.style.setProperty('--app-top', (vv ? vv.offsetTop : 0) + 'px');
    if (!kb && window.scrollY) window.scrollTo(0, 0);
  };
  vv?.addEventListener('resize', fit); vv?.addEventListener('scroll', fit);
  addEventListener('resize', fit);
  addEventListener('orientationchange', () => { base = 0; setTimeout(fit, 250); });
  document.addEventListener('focusin', () => setTimeout(fit, 60));
  document.addEventListener('focusout', () => { setTimeout(fit, 60); setTimeout(() => { if (!editing()) window.scrollTo(0, 0); fit(); }, 350); });
  fit();
  // niet in- of uitzoomen (iPhone: knijpen en dubbeltikken)
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, e => e.preventDefault());
  document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
}
const INST = { ev: null };
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); INST.ev = e; if (typeof S !== 'undefined' && S.tab === 'settings') renderSettings(); });
window.addEventListener('appinstalled', () => { INST.ev = null; if (typeof S !== 'undefined' && S.tab === 'settings') renderSettings(); });

/* =====================  helpers  ===================== */
const $ = (sel, root = document) => root.querySelector(sel);

// Kleine DOM-bouwer. Tekst gaat altijd via textContent (geen XSS); `html` alleen voor eigen iconen.
function h(tag, props, ...kids) {
  if (props == null || typeof props !== 'object' || props.nodeType || Array.isArray(props)) {
    kids.unshift(props); props = {};
  }
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {   // geneste lijsten (bijv. [kop, [schakelaars...]]) volledig platmaken, anders verschijnt "[object HTMLLabelElement]"
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const I = {
  shield: svg('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>'),
  calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  star: svg('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>'),
  reply: svg('<polyline points=\"9 17 4 12 9 7\"/><path d=\"M20 18v-2a4 4 0 0 0-4-4H4\"/>'),
  pencil: svg('<path d=\"M12 20h9\"/><path d=\"M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z\"/>'),
  eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  send: '<svg viewBox="0 0 24 24"><path d="M3.2 11.4 20.4 3.3c.9-.4 1.7.5 1.3 1.3L13.6 21.8c-.4.9-1.7.8-1.9-.2l-1.6-6.5L3.5 13.3c-1-.2-1.2-1.5-.3-1.9z" fill="url(#gradSend)"/></svg>',
  logout: svg('<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M16 8l4 4-4 4M20 12H9"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.5 4.43"/><path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07l1.33-1.33"/>'),
  moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  monitor: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  palette: svg('<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.5-1.9-.3-1 .4-2.1 1.5-2.1H17a4 4 0 0 0 4-4c0-5-4-10-9-10z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10.5" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  upload: svg('<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>'),
  lock: svg('<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'),
  bell: svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 9H3c0-1 3-2 3-9z"/><path d="M10 21a2 2 0 0 0 4 0"/>'),
  smile: svg('<circle cx="12" cy="12" r="9"/><path d="M8 14a4.5 4.5 0 0 0 8 0M9 9.5h.01M15 9.5h.01"/>'),
  up: svg('<path d="M6 15l6-6 6 6"/>'),
  down: svg('<path d="M6 9l6 6 6-6"/>'),
  fwd: svg('<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>'),
  phone: svg('<rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/>'),
  hash: svg('<path d="M5 9h14M4 15h14M10 3 8 21M16 3l-2 18"/>'),
  at: svg('<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>'),
  megaphone: svg('<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>'),
  crown: svg('<path d="M3 8l4 4 5-7 5 7 4-4-2 11H5z"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>')
};

function hash(s) { let x = 0; for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x; }
const PROF = {};   // uid -> profieldata (live voor vrienden, eenmalig opgehaald voor anderen)
// alleen echte jpeg-data-urls of hex-kleuren komen ooit in CSS terecht
const IMG_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, HEX_RE = /^#[0-9a-fA-F]{6}$/;
const safeImg = (s) => (typeof s === 'string' && IMG_RE.test(s)) ? s : '';
const safeBanner = (s) => (typeof s === 'string' && (HEX_RE.test(s) || IMG_RE.test(s))) ? s : '';
const gradFor = (id) => { const hu = hash(id) % 360; return `linear-gradient(135deg,hsl(${hu} 80% 62%),hsl(${(hu + 70) % 360} 80% 52%))`; };
const letterOf = (name) => (String(name || '?').trim()[0] || '?').toUpperCase();
function paintAvatar(el) {
  const src = el.dataset.uid && safeImg(PROF[el.dataset.uid]?.avatar);
  if (src) { el.style.background = `center / cover no-repeat url("${src}")`; el.textContent = ''; }
  else { el.style.background = gradFor(el.dataset.gid); el.textContent = el.dataset.ch; }
}
// isUser = true: toont de profielfoto (als die er is) en opent bij klikken het profiel
function avatar(id, name, size = 40, isUser = false) {
  const el = h('span', { class: 'avatar', style: `--s:${size}px`, 'data-gid': id, 'data-ch': letterOf(name), 'data-uid': isUser ? id : null });
  paintAvatar(el);
  return el;
}
let avRaf = 0;
function refreshAvatars() {
  cancelAnimationFrame(avRaf);
  avRaf = requestAnimationFrame(() => document.querySelectorAll('.avatar[data-gid]').forEach(paintAvatar));
}
function loadProfiles(uids) {
  for (const u of new Set(uids)) {
    if (!u || u in PROF) continue;
    PROF[u] = null;
    getDoc(doc(db, 'users', u)).then(s => { PROF[u] = s.exists() ? s.data() : null; onProfChange(u); }).catch(() => {});
  }
}

// avatar met presence-bolletje; de kleur wordt live bijgewerkt door renderPresence()
function dotted(uid, name, size = 40) {
  const d = h('i', { class: 'dot', 'data-uid': uid });
  setDot(d);
  return h('span', { class: 'av-wrap', style: `--s:${size}px` }, avatar(uid, name, size, true), d);
}

const tf = new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit' });
const df = new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
function dayLabel(d) {
  const now = new Date();
  if (dayKey(d) === dayKey(now)) return 'Vandaag';
  if (dayKey(d) === dayKey(new Date(now - 864e5))) return 'Gisteren';
  return df.format(d);
}

function toast(text) {
  const t = h('div', { class: 'toast', text });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3800);
}

// onSnapshot met automatisch opnieuw proberen. Een tijdelijke fout (vlak na inloggen, even geen verbinding, regels die net
// bijwerken) beëindigt een gewone luisteraar voorgoed; deze probeert het tot 3x opnieuw en meldt pas daarna iets.
function watch(name, q, next) {
  let stop = () => {}, dead = false;
  const start = (n) => {
    stop = onSnapshot(q, snap => { n = 0; next(snap); }, e => {
      console.error(name, e);
      if (dead) return;
      if (n < 3) setTimeout(() => { if (!dead) start(n + 1); }, 1000 * (n + 1));
      else toast(`${fbErr(e)} (${name})`);
    });
  };
  start(0);
  return () => { dead = true; stop(); };
}

function fbErr(e) {
  const c = e?.code || '';
  if (c.includes('permission-denied')) return 'Firestore weigerde dit verzoek (permission-denied). Probeer het zo nog eens. Blijft dit gebeuren, controleer dan of de nieuwste firestore.rules zijn gepubliceerd.';
  if (c.includes('not-found')) return 'Je Firestore-database bestaat nog niet (not-found). Maak hem aan in de Firebase Console: Build → Firestore Database → Database maken.';
  if (c.includes('unavailable')) return 'Geen verbinding met Firebase.';
  return (e?.message || 'Er ging iets mis.') + (c ? ` (${c})` : '');
}
function authErr(e) {
  switch (e?.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found': return 'Onjuiste e-mail of wachtwoord.';
    case 'auth/email-already-in-use': return 'Dit e-mailadres is al in gebruik.';
    case 'auth/weak-password': return 'Kies een wachtwoord van minimaal 6 tekens.';
    case 'auth/invalid-email': return 'Dit e-mailadres klopt niet.';
    case 'auth/too-many-requests': return 'Te veel pogingen. Probeer het later opnieuw.';
    case 'auth/operation-not-allowed': return 'Deze inlogmethode staat nog uit in de Firebase Console (Authentication → Sign-in method).';
    case 'auth/unauthorized-domain': return `Het domein "${location.hostname}" staat niet bij de toegestane domeinen. Open de site via localhost, of voeg dit domein toe in Firebase Console → Authentication → Instellingen → Geautoriseerde domeinen.`;
    case 'auth/network-request-failed': return 'Netwerkfout — controleer je internetverbinding.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request': return '';
    default: return fbErr(e);
  }
}

/* =====================  tiers: Infinitum / Infinitum+ / Infinitum Prime  =====================
   Het tier van iemand staat in het profiel: users/{uid}.tier = "plus" of "prime" (leeg = gewoon Infinitum).
   Je zet het zelf per persoon in de Firebase Console; gebruikers kunnen het niet zelf wijzigen (zie firestore.rules). */
const TIERS = {
  free:  { name: 'Infinitum',       logo: 'assets/infinitum-logo.svg',       icon: 'assets/favicon.svg' },
  plus:  { name: 'Infinitum+',      logo: 'assets/infinitum-logo-plus.svg',  icon: 'assets/favicon-plus.svg' },
  prime: { name: 'Infinitum Prime', logo: 'assets/infinitum-logo-prime.svg', icon: 'assets/favicon-prime.svg' }
};
const tierKey = (p) => (p && (p.tier === 'plus' || p.tier === 'prime') ? p.tier : 'free');
const myTier = () => TIERS[tierKey(S.profile)];
// zet favicon + alle zichtbare tier-logo's op het tier van de ingelogde gebruiker
function applyTier() {
  const t = myTier();
  const link = document.getElementById('favicon');
  if (link && link.getAttribute('href') !== t.icon) link.setAttribute('href', t.icon);
  document.querySelectorAll('img[data-tier-logo]').forEach(i => { if (i.getAttribute('src') !== t.logo) i.setAttribute('src', t.logo); });
}

/* =====================  state  ===================== */
const S = {
  me: null, profile: null, tab: 'dms',
  friendships: [], meta: {}, metaUnsub: {},
  servers: [], activeDm: null, activeServer: null, activeChannel: null, channels: {}, channelsFor: null,
  chat: null, unsub: {}, pendingName: null, started: false,
  metaSeen: {}, reqSeen: null, settingsSeeded: false
};

/* typ-indicator: staat aan tenzij config/features.typingIndicators op false staat */
const TY = { enabled: true, ttl: 6000, every: 3000 };
/* leesbewijzen: aan tenzij config/features.readReceipts op false staat EN jij ze niet zelf uitzet (Instellingen -> Privacy) */
const RR = { enabled: true, every: 3000 };

/* abonnementen: de functielijst staat in Firestore (collectie `features`), prijzen in config/plans */
const FEATURES = [];
const PLANCFG = {};
const SUB = { mine: null, pending: [] };
let plansView = null;
let adminView = null;
const DEFAULT_FEATURES = [
  { id: 'd1', name: 'Berichten, vrienden en servers', free: true, plus: true, prime: true, order: 1 },
  { id: 'd2', name: 'Eigen profielkleuren en banner', free: false, plus: true, prime: true, order: 2 },
  { id: 'd3', name: 'Grotere bestanden versturen', free: false, plus: false, prime: true, order: 3 },
  { id: 'd4', name: 'Exclusieve emoji en badges', free: false, plus: false, prime: true, order: 4 }
];

const pairId = (a, b) => [a, b].sort().join('_');
const accepted = () => S.friendships.filter(f => f.status === 'accepted');
const incoming = () => S.friendships.filter(f => f.status === 'pending' && f.requester !== S.me.uid);
const outgoing = () => S.friendships.filter(f => f.status === 'pending' && f.requester === S.me.uid);
const otherId = (f) => f.users.find(u => u !== S.me.uid);
const otherName = (f) => PROF[otherId(f)]?.username || (f.names && f.names[otherId(f)]) || 'Onbekend';
const dmInfo = (id) => { const f = accepted().find(x => x.id === id); return f ? { uid: otherId(f), name: otherName(f) } : null; };
const serverInfo = (id) => S.servers.find(s => s.id === id) || null;
const setView = (v) => { $('#app').dataset.view = v; };

/* =====================  inloggen  ===================== */
let mode = 'login';
function setMode(m) {
  mode = m;
  document.querySelectorAll('#authSeg button').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  $('#userField').hidden = m !== 'signup';
  $('#aSubmit').textContent = m === 'signup' ? 'Account maken' : 'Inloggen';
  $('#aPass').autocomplete = m === 'signup' ? 'new-password' : 'current-password';
  $('#aErr').textContent = '';
}
$('#authSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); });
$('#logoutBtn').innerHTML = I.logout;

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#aErr'), btn = $('#aSubmit');
  err.textContent = '';
  const email = $('#aMail').value.trim(), pass = $('#aPass').value;
  if (!email || !pass) { err.textContent = 'Vul je e-mail en wachtwoord in.'; return; }
  btn.disabled = true;
  try {
    if (mode === 'signup') {
      const name = $('#aUser').value.trim();
      if (!/^[A-Za-z0-9_.]{2,20}$/.test(name)) throw { code: 'x', message: 'Gebruikersnaam: 2–20 tekens, alleen letters, cijfers, _ en .' };
      try {
        const taken = await getDoc(doc(db, 'usernames', name.toLowerCase()));
        if (taken.exists()) throw { code: 'x', message: 'Deze gebruikersnaam is al bezet.' };
      } catch (pre) {
        if (pre.code === 'x') throw pre;
        console.warn('Gebruikersnaam-check overgeslagen:', pre); // Firestore-problemen worden hierna netjes gemeld
      }
      S.pendingName = { email: email.toLowerCase(), name };
      await createUserWithEmailAndPassword(auth, email, pass);
    } else {
      await signInWithEmailAndPassword(auth, email, pass);
    }
  } catch (ex) {
    S.pendingName = null;
    err.textContent = ex.code === 'x' ? ex.message : authErr(ex);
  } finally { btn.disabled = false; }
});

$('#aGoogle').addEventListener('click', async () => {
  $('#aErr').textContent = '';
  try { await signInWithPopup(auth, googleProvider); }
  catch (ex) {
    if (ex.code === 'auth/popup-blocked') {
      try { await signInWithRedirect(auth, googleProvider); return; } catch (e2) { ex = e2; }
    }
    console.error(ex);
    $('#aErr').textContent = authErr(ex);
  }
});
$('#logoutBtn').addEventListener('click', async () => {
  if (setTimer) saveSetNow();   // wachtende instellingen eerst naar Firebase
  await Promise.race([pushDetach(), new Promise(r => setTimeout(r, 1500))]);   // geen meldingen van dit account meer op dit toestel
  await Promise.race([presenceGoOffline(), new Promise(r => setTimeout(r, 1500))]); // meteen offline tonen
  signOut(auth);
});

// Maakt (atomair) profiel + unieke gebruikersnaam aan bij de eerste keer.
async function ensureProfile(user) {
  const ref = doc(db, 'users', user.uid);
  if ((await getDoc(ref)).exists()) return;

  const pend = S.pendingName && S.pendingName.email === (user.email || '').toLowerCase() ? S.pendingName.name : null;
  let base = (pend || user.displayName || (user.email || 'user').split('@')[0] || 'user')
    .replace(/[^A-Za-z0-9_.]/g, '').slice(0, 16);
  if (base.length < 2) base = 'user' + Math.floor(Math.random() * 90 + 10);

  let name = base;
  for (let i = 0; i < 8; i++) {
    const lower = name.toLowerCase();
    if ((await getDoc(doc(db, 'usernames', lower))).exists()) {
      name = base.slice(0, 15) + Math.floor(Math.random() * 900 + 100);
      continue;
    }
    const batch = writeBatch(db);
    batch.set(doc(db, 'usernames', lower), { uid: user.uid });
    batch.set(ref, { username: name, usernameLower: lower, status: '', tier: 'free', createdAt: serverTimestamp() });
    await batch.commit(); // echte fouten (regels / database ontbreekt) komen hier naar boven
    S.pendingName = null;
    if (pend && name.toLowerCase() !== pend.toLowerCase()) toast(`"${pend}" was al bezet — je bent ${name} geworden.`);
    return;
  }
  throw new Error('Kon geen vrije gebruikersnaam vinden.');
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    teardown();
    $('#app').hidden = true; $('#auth').hidden = false;
    return;
  }
  if (S.started && S.me?.uid === user.uid) return;
  S.me = user;
  try { await ensureProfile(user); }
  catch (e) {
    console.error(e);
    $('#aErr').textContent = fbErr(e);
    await signOut(auth);
    return;
  }
  S.started = true;
  startListeners();
  $('#auth').hidden = true; $('#app').hidden = false;
  setTab('dms');
  pushRefresh();
  applyOpen();
});

/* =====================  realtime  ===================== */
function startListeners() {
  const uid = S.me.uid;
  S.unsub.profile = onSnapshot(doc(db, 'users', uid), s => { S.profile = s.data() || null; PROF[uid] = S.profile; applyTier(); applyAppearance(); renderUserCard(); refreshAvatars(); },
    e => console.error(e));

  // jouw instellingen (thema, meldingen, privacy): Firestore -> settings -> <jouw uid>
  S.unsub.settings = onSnapshot(doc(db, 'settings', uid), s => {
    if (!s.exists()) {
      // eerste keer: zet de huidige (lokale) instellingen in je account
      if (!s.metadata.fromCache && !S.settingsSeeded) { S.settingsSeeded = true; saveSetNow(); }
      return;
    }
    if (s.metadata.hasPendingWrites || setTimer) return;   // eigen wijziging die nog onderweg is
    const next = mergeCfg(s.data());
    if (JSON.stringify(next) === JSON.stringify(CFG)) return;
    Object.assign(CFG, next);
    cacheLook(); applyAppearance(); applyProfileClick(); syncReadWatch();
    if (S.tab === 'settings') renderSettings();
  }, e => console.error(e));

  S.unsub.friends = watch('vrienden', query(collection(db, 'friendships'), where('users', 'array-contains', uid)), snap => {
    S.friendships = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    syncChatMeta(); syncUnread(); scheduleWatch(); checkNewRequests();
    renderTabs(); scheduleSidebar();
    if (S.tab === 'friends') renderFriendList();
    if (S.tab === 'requests') renderRequestLists();
    if (S.tab === 'dms') {
      if (S.activeDm && !dmInfo(S.activeDm)) { S.activeDm = null; showMain(); }
    }
  });

  S.unsub.servers = watch('servers', query(collection(db, 'servers'), where('members', 'array-contains', uid)), snap => {
    S.servers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    ensureOfficial(); syncChannels();
    if (S.activeServer && !serverInfo(S.activeServer)) {
      S.activeServer = null; S.activeChannel = null; syncChannels();
      if (S.tab === 'servers') showMain();
    } else if (S.chat?.type === 'server') srvChanged();
    ssView?.render(); scheduleSidebar(); scheduleWatch();
  });

  // noodschakelaar: Firestore -> config -> features -> typingIndicators (true/false)
  S.unsub.config = onSnapshot(doc(db, 'config', 'features'), s => {
    TY.enabled = s.exists() ? s.data().typingIndicators !== false : true;
    RR.enabled = s.exists() ? s.data().readReceipts !== false : true;
    if (S.chat) { TY.enabled ? startTypingWatch() : stopTypingWatch(); renderTyping(); syncReadWatch(); }
  }, () => { TY.enabled = false; RR.enabled = false; stopTypingWatch(); renderTyping(); syncReadWatch(); });

  // alle badges (klein): Firestore -> badges -> <badge-id>
  S.unsub.badges = onSnapshot(collection(db, 'badges'), snap => {
    BADGES.length = 0;
    snap.forEach(d => BADGES.push({ id: d.id, ...d.data() }));
    syncModWatch(); syncSubsWatch(); renderPremiumBadge(); renderTabs(); plansView?.render(); ensureOfficial(); if (S.chat?.type === 'server') srvChanged();
    if (S.tab === 'settings') paintCredits();
  }, () => {});

  // functies per abonnement: Firestore -> features -> <id> { name, free, plus, prime, order }
  S.unsub.features = onSnapshot(collection(db, 'features'), snap => {
    FEATURES.length = 0;
    snap.forEach(d => FEATURES.push({ id: d.id, ...d.data() }));
    plansView?.render();
  }, () => {});
  // prijzen (optioneel): Firestore -> config -> plans -> plusPrice / primePrice
  S.unsub.plans = onSnapshot(doc(db, 'config', 'plans'), s => {
    for (const k of Object.keys(PLANCFG)) delete PLANCFG[k];
    if (s.exists()) Object.assign(PLANCFG, s.data());
    plansView?.render();
  }, () => {});
  // mijn eigen abonnementsaanvraag
  S.unsub.sub = onSnapshot(doc(db, 'subscriptions', uid), s => {
    SUB.mine = s.exists() ? s.data({ serverTimestamps: 'estimate' }) : null;
    plansView?.render();
  }, () => {});

  startInbox(uid);
  startPresence();
}

function syncChatMeta() {
  const ids = new Set(accepted().map(f => f.id));
  for (const id of Object.keys(S.metaUnsub)) {
    if (!ids.has(id)) { S.metaUnsub[id](); delete S.metaUnsub[id]; delete S.meta[id]; delete S.metaSeen[id]; }
  }
  for (const id of ids) {
    if (S.metaUnsub[id]) continue;
    S.metaUnsub[id] = onSnapshot(doc(db, 'chats', id), s => {
      const prev = S.meta[id], cur = s.data() || null;
      S.meta[id] = cur;
      // nieuw bericht van de ander (niet bij het eerste laden, niet als je dat gesprek open hebt)
      if (S.metaSeen[id] && cur && !s.metadata.hasPendingWrites && cur.lastUid && cur.lastUid !== S.me?.uid) {
        const before = prev?.lastAt?.toMillis?.() || 0, now = cur.lastAt?.toMillis?.() || 0;
        const open = S.tab === 'dms' && S.activeDm === id && isVisible();
        if (now > before && !open) {
          const f = accepted().find(x => x.id === id);
          notify('dm', f ? otherName(f) : 'Nieuw bericht', cur.lastText || '', () => {
            S.activeDm = id; S.tab = 'dms'; renderTabs(); renderSidebar(); showMain();
          }, 'dm:' + id);
        }
      }
      S.metaSeen[id] = true;
      scheduleSidebar();
    }, () => {});
  }
}

function unsubChat() { $('#app').dataset.chat = ''; stopTypingWatch(); stopReadWatch(); clearTimeout(S.chat?.typeT); S.unsub.chat?.(); S.unsub.chat = null; S.chat = null; scheduleWatch(); }
function teardown() {
  stopPresence();
  unsubChat();
  for (const k of ['profile', 'friends', 'servers', 'channels', 'config', 'badges', 'features', 'plans', 'sub', 'mods', 'settings', 'subs', 'upg', 'inbox']) { S.unsub[k]?.(); S.unsub[k] = null; }
  adminView = null; INBOX.list = []; INBOX.ready = false;
  BADGES.length = 0; FEATURES.length = 0; SUB.mine = null; SUB.pending = []; SUBS.list = []; SUBS.ready = false;
  resetPrivateCfg();
  for (const k of Object.keys(PLANCFG)) delete PLANCFG[k];
  stopUnread(); stopAdminWatch(); renderPremiumBadge();
  Object.values(S.metaUnsub).forEach(u => u());
  Object.assign(S, { me: null, profile: null, friendships: [], meta: {}, metaUnsub: {}, servers: [], activeDm: null, activeServer: null, activeChannel: null, channels: {}, channelsFor: null, officialTried: false, started: false, tab: 'dms', metaSeen: {}, reqSeen: null, settingsSeeded: false });
  for (const k of Object.keys(PROF)) delete PROF[k];
  applyTier();   // favicon terug naar gewoon Infinitum
  $('#main').replaceChildren(); $('#sideList').replaceChildren(); $('#sideFoot').replaceChildren();
}

/* =====================  tabs + zijbalk  ===================== */
$('#tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b) setTab(b.dataset.tab); });

// instellingen / admin / meldingen: op de telefoon eerst de zijbalk (categorieën) tonen, pas na een tik de inhoud
function setTab(t) { S.tab = t; renderTabs(); renderSidebar(true); showMain(['settings', 'admin', 'inbox'].includes(t) ? 'list' : undefined); }

function renderTabs() {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === S.tab));
  const n = S.me ? incoming().length : 0;
  const bd = $('#reqBadge'); bd.hidden = !n; bd.textContent = n;
  $('#settingsBtn').classList.toggle('active', S.tab === 'settings');
  $('#adminBtn')?.classList.toggle('active', S.tab === 'admin');
  $('#inboxBtn')?.classList.toggle('active', S.tab === 'inbox');
}

function renderUserCard() {
  const p = S.profile;
  $('#meAvatar').replaceChildren(dotted(S.me.uid, p?.username, 46));
  $('#meName').textContent = p?.username || '…';
}

let sideRaf = 0;
function scheduleSidebar() { cancelAnimationFrame(sideRaf); sideRaf = requestAnimationFrame(() => renderSidebar()); }

// zachte inschuif-animatie voor de zijbalk bij het wisselen van tabblad (de .swap-klasse gaat daarna weer weg)
function swapAnim(...els) {
  els.forEach(el => {
    [...el.children].slice(0, 16).forEach((c, i) => c.style.setProperty('--i', i));
    el.classList.remove('swap'); void el.offsetWidth; el.classList.add('swap');
    clearTimeout(el._swapT); el._swapT = setTimeout(() => el.classList.remove('swap'), 800);
  });
}

let sideSig = '';
function renderSidebar(animate = false) {
  if (!S.me) return;
  const list = $('#sideList'), foot = $('#sideFoot');
  if (S.tab === 'settings') {
    $('#sideTitle').textContent = 'Instellingen';
    if (list.dataset.mode === 'settings') return;   // niet opnieuw opbouwen: anders raak je de zoekbalk kwijt tijdens het typen
    list.dataset.mode = 'settings'; sideSig = '';
    buildSettingsNav(list, foot);
    swapAnim(list, foot);
    return;
  }
  if (S.tab === 'admin' || S.tab === 'inbox') {
    $('#sideTitle').textContent = S.tab === 'admin' ? 'Admin' : 'Meldingen';
    const first = list.dataset.mode !== S.tab;
    list.dataset.mode = S.tab; sideSig = '';
    buildPageNav(list, foot);
    if (first) swapAnim(list, foot);
    return;
  }
  const had = list.dataset.mode; delete list.dataset.mode;
  // eerst "ernaast" opbouwen: is het resultaat identiek aan wat er al staat, dan laten we de zijbalk met rust (geen geflikker)
  const nl = document.createElement('div'), nf = document.createElement('div');
  fillSidebar(nl, nf);
  const sig = S.tab + '\n' + nl.innerHTML + '\n' + nf.innerHTML;
  if (sig === sideSig && !animate && !had) return;
  sideSig = sig;
  list.replaceChildren(...nl.childNodes); foot.replaceChildren(...nf.childNodes);
  if (animate || had) swapAnim(list, foot);
}

function fillSidebar(list, foot) {
  if (S.tab === 'servers') { fillServerSidebar(list, foot); return; }

  $('#sideTitle').textContent = 'Directe berichten';
  const when = (f) => S.meta[f.id]?.lastAt?.toMillis?.() || 0;
  const friends = [...accepted()].sort((a, b) => when(b) - when(a) || otherName(a).localeCompare(otherName(b)));
  if (!friends.length) list.append(h('p', { class: 'hint', text: 'Nog geen vrienden. Voeg iemand toe via het tabblad Friends.' }));
  for (const f of friends) {
    const m = S.meta[f.id];
    const preview = m?.lastText ? (m.lastUid === S.me.uid ? 'Jij: ' : '') + m.lastText : 'Begin een gesprek';
    list.append(h('button', {
      class: 'item' + (S.activeDm === f.id && S.tab === 'dms' ? ' active' : '') + (unreadOf(f.id) ? ' has-unread' : ''),
      onclick: () => { S.activeDm = f.id; if (S.tab !== 'dms') { S.tab = 'dms'; renderTabs(); } renderSidebar(); showMain(); }
    },
      dotted(otherId(f), otherName(f), 42),
      h('span', { class: 'item-text' }, h('b', { text: otherName(f) }), h('small', { text: preview })),
      unreadBadge(f.id),
      pbadge(otherId(f))));
  }
}

/* =====================  hoofdvlak  ===================== */
function showMain(pageView) {
  unsubChat();
  const keep = () => pageView || $('#app').dataset.view || 'main';   // pagina's: gevraagde weergave, anders de huidige laten staan
  if (S.tab === 'admin' && BADGES.length && !isAdmin()) { S.tab = 'dms'; renderTabs(); renderSidebar(true); }
  if (S.tab !== 'admin' && adminView) { adminView = null; syncSubsWatch(); }
  if (S.tab === 'friends') { renderFriends(); setView('main'); return; }
  if (S.tab === 'requests') { renderRequests(); setView('main'); return; }
  if (S.tab === 'settings') { renderSettings(); setView(keep()); return; }
  if (S.tab === 'admin') { renderAdmin(); setView(keep()); return; }
  if (S.tab === 'inbox') { renderInbox(); setView(keep()); return; }
  const type = S.tab === 'dms' ? 'dm' : 'server';
  if (type === 'server' && !S.activeServer && S.servers.length && matchMedia('(min-width: 801px)').matches) {   // desktop: meteen de officiële (of eerste) server openen
    S.activeServer = (S.servers.find(x => x.official) || [...S.servers].sort((a, b) => a.name.localeCompare(b.name))[0]).id; renderSidebar();
  }
  const id = type === 'dm' ? S.activeDm : S.activeServer;
  if (type === 'server' && id && serverInfo(id)) {
    syncChannels();
    const ch = S.activeChannel && chanById(serverInfo(id), S.activeChannel);
    if (ch && canView(serverInfo(id), ch)) { openChat('server', id); setView('main'); return; }
    S.activeChannel = null; renderEmpty('channel'); setView('list'); autoPickChannel(); return;
  }
  if (id && (type === 'dm' ? dmInfo(id) : serverInfo(id))) { openChat(type, id); setView('main'); }
  else { renderEmpty(type); setView('list'); }
}

function renderEmpty(type) {
  $('#main').replaceChildren(h('div', { class: 'empty' },
    h('img', { src: myTier().logo, alt: myTier().name, 'data-tier-logo': true }),
    h('h2', { text: type === 'dm' ? 'Kies een gesprek' : type === 'channel' ? 'Kies een kanaal' : 'Kies een server' }),
    h('p', { text: type === 'dm' ? 'Selecteer een vriend links om te chatten.' : type === 'channel' ? 'Selecteer links een kanaal van deze server.' : 'Selecteer een server links, of maak er zelf een.' })));
}

function buildHead(type, id) {
  const back = h('button', {
    class: 'icon-btn back', type: 'button', html: I.back, 'aria-label': 'Terug',
    onclick: () => { if (type === 'dm') S.activeDm = null; else S.activeChannel = null; renderSidebar(); showMain(); }
  });
  const head = h('div', { class: 'chat-head', id: 'chatHead' }, back);

  if (type === 'dm') {
    const i = dmInfo(id);
    head.append(dotted(i.uid, i.name, 42), h('div', { class: 'grow' }, h('h2', { text: i.name }), h('small', { id: 'peerStatus' })));
    getDoc(doc(db, 'users', i.uid)).then(s => {
      const el = $('#peerStatus'); if (el && s.exists()) { el.dataset.st = s.data().status || ''; renderPresence(); }
    }).catch(() => {});
  } else {
    const s = serverInfo(id), ch = chanById(s, S.activeChannel) || { name: 'algemeen', type: 'text' };
    head.append(
      srvAvatar(s, 42),
      h('div', { class: 'grow' }, h('h2', { class: 'ch-title' }, h('span', { class: 'ch-ic', html: ch.type === 'announce' ? I.megaphone : I.hash }), ch.name),
        h('small', { id: 'srvMeta', text: s.name + ' · ' + srvMetaText(s) })),
      h('button', { class: 'ghost sm', type: 'button', onclick: openMembers, text: 'Leden' }),
      h('button', { class: 'icon-btn', type: 'button', html: I.copy, title: 'Uitnodigingscode kopiëren', 'aria-label': 'Uitnodigingscode kopiëren',
        onclick: async () => { try { await navigator.clipboard.writeText(id); toast('Code gekopieerd — deel hem met vrienden.'); } catch { toast('Code: ' + id); } } }),
      anyManage(s) ? h('button', { class: 'icon-btn', type: 'button', html: I.gear, title: 'Serverinstellingen', 'aria-label': 'Serverinstellingen', onclick: () => openServerSettings() }) : null,
      s.official ? null : h('button', {
        class: 'icon-btn', type: 'button', html: s.ownerId === S.me.uid ? I.trash : I.logout,
        title: s.ownerId === S.me.uid ? 'Server verwijderen' : 'Server verlaten', 'aria-label': s.ownerId === S.me.uid ? 'Server verwijderen' : 'Server verlaten',
        onclick: () => s.ownerId === S.me.uid ? deleteServer(s) : leaveServer(s)
      }));
  }
  return head;
}

function openChat(type, id) {
  unsubChat();
  const col = type === 'dm' ? collection(db, 'chats', id, 'messages') : chanMsgCol(id, S.activeChannel);
  $('#app').dataset.chat = '1';
  S.chat = { type, id, cid: type === 'server' ? S.activeChannel : null, col, first: true, seen: {}, lastPing: 0, lastId: null, reads: {}, newest: null, markedId: null, lastRead: 0, lastMineAt: 0 };
  const name = type === 'dm' ? dmInfo(id).name : serverInfo(id).name;
  const chName = type === 'server' ? '#' + (chanById(serverInfo(id), S.activeChannel)?.name || 'algemeen') : '';

  const ta = h('textarea', {
    id: 'msgInput', name: 'chat-bericht', rows: 1, maxlength: 2000,
    autocomplete: 'off', 'data-form-type': 'other', 'data-lpignore': 'true', 'data-1p-ignore': 'true',
    placeholder: type === 'dm' ? `Bericht aan ${name}` : `Bericht in ${chName}`
  });
  const doSend = async () => {
    const text = ta.value.trim();
    const c = S.chat;
    if (!text || !c) return;
    if (c.editing) {   // bericht bewerken: opslaan
      const id = c.editing, old = c.byId?.[id];
      cancelCompose();
      if (old && old.text !== text) await editMessage(id, text);
      return;
    }
    const reply = c.replyTo;
    ta.value = ''; ta.style.height = 'auto'; c.replyTo = null; paintCompose();
    try { await sendMessage(text, reply); }
    catch (e) { ta.value = text; if (S.chat === c) { c.replyTo = reply; paintCompose(); } toast(fbErr(e)); }
  };
  ta.addEventListener('input', () => {
    ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
    if (ta.value.trim()) pingTyping();
    if (type === 'server') mentionSuggest(ta);
  });
  ta.addEventListener('keydown', e => {
    if (type === 'server' && mentionKey(e, ta)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); }
    else if (e.key === 'Escape' && (S.chat?.editing || S.chat?.replyTo)) { e.preventDefault(); cancelCompose(); }
  });

  $('#main').replaceChildren(
    buildHead(type, id),
    h('div', { class: 'msgs', id: 'msgList' }),
    h('div', { class: 'typing', id: 'typingBar', 'aria-live': 'polite' }),
    h('div', { class: 'cbar', id: 'cbar', hidden: true }),
    h('div', { class: 'composer' },
      h('div', { class: 'box' }, ta, h('div', { class: 'mn-pop', id: 'mnPop', hidden: true })),
      h('button', { class: 'glow send', type: 'button', title: 'Versturen', 'aria-label': 'Versturen', html: I.send, onclick: doSend })));

  let primed = false;
  const PAGE = 50;
  const c0 = S.chat;
  c0.limit = PAGE; c0.hasMore = false; c0.loadingMore = false;
  const subscribe = (lim) => { S.unsub.chat?.(); S.unsub.chat = watch('berichten', query(col, orderBy('createdAt', 'desc'), limit(lim)), onMsgs, lim); };
  // omhoog scrollen = oudere berichten bijladen (telkens PAGE erbij)
  c0.more = () => {
    if (S.chat !== c0 || !c0.hasMore || c0.loadingMore) return;
    const list = $('#msgList'); if (!list) return;
    c0.loadingMore = true; c0.anchor = { h: list.scrollHeight, t: list.scrollTop };
    c0.limit += PAGE; subscribe(c0.limit);
  };
  const onMsgs = snap => {
    if (S.chat !== c0) return;
    // servermeldingen: alleen voor de server die open staat terwijl je tabblad op de achtergrond is
    if (primed && type === 'server' && !snap.metadata.hasPendingWrites && !(isVisible() && document.hasFocus())) {
      for (const ch of snap.docChanges()) {
        const m = ch.type === 'added' ? ch.doc.data({ serverTimestamps: 'estimate' }) : null;
        if (m && m.uid !== S.me.uid && !mentionsMe(serverInfo(id), m) && !serverInfo(id)?.official) notify('server', `${m.name || 'Onbekend'} in ${name} ${chName}`, m.text, () => {});
      }
    }
    primed = true;
    const msgs = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) })).reverse();
    c0.hasMore = snap.docs.length >= c0.limit;
    renderMessages(msgs);
    if (type === 'server') { const k = [...new Set(msgs.map(m => m.uid))].sort().join(','); if (k !== c0.authKey) { c0.authKey = k; scheduleWatch(); } }
  };
  subscribe(c0.limit);
  $('#msgList').addEventListener('scroll', e => { if (e.target.scrollTop < 120) c0.more?.(); }, { passive: true });

  if (matchMedia('(min-width: 801px)').matches) ta.focus();
  if (type === 'server') applyComposerAccess();
  scheduleWatch(); renderPresence();
  startTypingWatch();
  syncReadWatch();
}

/* =====================  leesbewijzen  ===================== */
// Per gesprek: <chat of server>/reads/<uid> met { at } = het moment waarop jij voor het laatst alles las.
// Eén schrijfactie per 3 s, alleen als er iets nieuws van een ander is en het tabblad open + actief is.
// Een bericht is gelezen door iemand als diens `at` na het bericht ligt. Het oogje staat onder je laatste bericht.
function startReadWatch() {
  const c = S.chat;
  if (!rrOn() || !c || c.readUnsub) return;
  c.readsCol = collection(c.col.parent, 'reads');
  c.readUnsub = onSnapshot(c.readsCol, snap => {
    if (S.chat !== c) return;
    for (const ch of snap.docChanges()) {
      if (ch.type === 'removed') { delete c.reads[ch.doc.id]; continue; }
      c.reads[ch.doc.id] = ch.doc.data({ serverTimestamps: 'estimate' }).at?.toMillis?.() || 0;
    }
    updateReceipt();
  }, () => {});
}

function stopReadWatch() {
  const c = S.chat;
  if (!c) return;
  clearTimeout(c.readT);
  c.readUnsub?.(); c.readUnsub = null;
  c.reads = {};
}

function syncReadWatch() {
  if (!S.chat) return;
  if (rrOn()) { startReadWatch(); markRead(); } else stopReadWatch();
  updateReceipt();
}

function markRead() {
  const c = S.chat;
  if (!rrOn() || !c?.readsCol || !c.newest || c.newest.uid === S.me.uid || c.markedId === c.newest.id + ':' + c.newest.ver) return;
  if (!isVisible() || !document.hasFocus() || activeManual() === 'invisible') return;
  clearTimeout(c.readT);
  const wait = c.lastRead + RR.every - Date.now();
  if (wait > 0) { c.readT = setTimeout(markRead, wait); return; }
  c.markedId = c.newest.id + ':' + c.newest.ver; c.lastRead = Date.now();
  setDoc(doc(c.readsCol, S.me.uid), { at: serverTimestamp() }).catch(() => { if (S.chat === c) c.markedId = null; });
}
window.addEventListener('focus', () => markRead());
document.addEventListener('visibilitychange', () => markRead());

// Elke lezer krijgt zijn eigen plek: onder jouw laatste bericht dat hij/zij gelezen had (createdAt <= zijn `at`).
// Stuur je iets nieuws, dan blijft het oogje dus staan tot die persoon het gesprek weer opent en doorleest.
// In servers staan er meerdere oogjes onder elkaar: elk met het aantal mensen dat precies tot daar las.
function updateReceipt() {
  const c = S.chat;
  if (!c) return;
  document.querySelectorAll('#msgList .receipt').forEach(el => el.replaceChildren());
  if (!rrOn() || !c.mine?.length) return;
  const allowed = new Set(c.type === 'dm' ? [dmInfo(c.id)?.uid] : (serverInfo(c.id)?.members || []));
  const groups = new Map();   // bericht-id -> [uid, ...]
  for (const [u, at] of Object.entries(c.reads)) {
    if (u === S.me.uid || !allowed.has(u) || !at) continue;
    let hit = null;
    for (const m of c.mine) { if (m.ms <= at) hit = m; else break; }
    if (!hit) continue;
    if (!groups.has(hit.id)) groups.set(hit.id, []);
    groups.get(hit.id).push(u);
  }
  for (const [id, users] of groups) {
    const el = document.querySelector(`#msgList .receipt[data-mid="${CSS.escape(id)}"]`);
    if (!el) continue;
    const names = users.map(u => PROF[u]?.username).filter(Boolean).slice(0, 10).join(', ');
    el.append(h('span', {
      class: 'rcpt', title: names ? 'Gelezen door ' + names : 'Gelezen',
      'aria-label': c.type === 'server' ? `Gelezen door ${users.length}` : 'Gelezen'
    }, h('span', { class: 'rcpt-ic', html: I.eye }), c.type === 'server' ? h('b', { text: String(users.length) }) : null));
  }
}

/* =====================  typ-indicator  ===================== */
// Per gesprek: <chat of server>/typing/<uid> met { at }. Eén schrijfactie per 3 s zolang je typt,
// niets bij stoppen of versturen (de indicator verloopt vanzelf na 6 s of zodra er een bericht komt).
function pingTyping() {
  const c = S.chat;
  if (!TY.enabled || !c?.typingCol || activeManual() === 'invisible') return;
  const now = Date.now();
  if (now - c.lastPing < TY.every) return;
  c.lastPing = now;
  setDoc(doc(c.typingCol, S.me.uid), { at: serverTimestamp() }).catch(() => {});
}

function startTypingWatch() {
  const c = S.chat;
  if (!TY.enabled || !c || c.typingUnsub) return;
  c.typingCol = collection(c.col.parent, 'typing');
  let primed = false;
  c.typingUnsub = onSnapshot(c.typingCol, snap => {
    if (S.chat !== c) return;
    for (const ch of snap.docChanges()) {
      if (ch.type === 'removed' || ch.doc.id === S.me.uid || ch.doc.metadata.hasPendingWrites) continue;
      const at = ch.doc.data({ serverTimestamps: 'estimate' }).at?.toMillis?.() || 0;
      if (!primed && Date.now() - at > TY.ttl) continue;   // oud document bij het openen
      c.seen[ch.doc.id] = Date.now();
      loadProfiles([ch.doc.id]);
    }
    primed = true;
    renderTyping();
  }, () => {});
}

function stopTypingWatch() {
  const c = S.chat;
  if (!c) return;
  c.typingUnsub?.(); c.typingUnsub = null;
  c.seen = {};
}

function renderTyping() {
  const el = $('#typingBar'), c = S.chat;
  if (!el || !c) return;
  clearTimeout(c.typeT);
  const now = Date.now(), names = [];
  let next = Infinity;
  if (TY.enabled) {
    for (const [u, t] of Object.entries(c.seen)) {
      const left = t + TY.ttl - now;
      if (left <= 0) { delete c.seen[u]; continue; }
      next = Math.min(next, left);
      names.push(PROF[u]?.username || 'Iemand');
    }
  }
  if (!names.length) { el.replaceChildren(); return; }
  const text = names.length === 1 ? `${names[0]} is aan het typen…`
    : names.length === 2 ? `${names[0]} en ${names[1]} zijn aan het typen…`
    : 'Meerdere mensen zijn aan het typen…';
  el.replaceChildren(h('span', { class: 'tdots' }, h('i'), h('i'), h('i')), h('span', { text }));
  c.typeT = setTimeout(renderTyping, next + 50);
}

/* Typen buiten de typbalk: de balk blijft met rust gelaten als je ernaast klikt,
   maar zodra je begint te typen springt de cursor automatisch terug in de chatbalk.
   Niet als je al in een ander invoerveld zit (status, zoeken, dialoog, enz.). */
document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.isComposing) return;
  const ta = $('#msgInput');
  if (!S.chat || !ta || !ta.isConnected || $('#app').hidden) return;
  if (document.activeElement === ta) return;
  if (document.querySelector('dialog[open]')) return;

  const a = document.activeElement;
  if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;

  const paste = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v';
  const typing = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
  if (!paste && !typing) return;
  // spatie activeert een knop die focus heeft; die niet afpakken
  if (e.key === ' ' && a && /^(BUTTON|A|SUMMARY)$/.test(a.tagName)) return;

  ta.focus(); // geen preventDefault: het teken landt hierna vanzelf in de balk
});

function renderMessages(msgs) {
  const list = $('#msgList'); if (!list || !S.chat) return;
  const c = S.chat;
  const nearBottom = c.first || list.scrollHeight - list.scrollTop - list.clientHeight < 140;
  const keepTop = list.scrollTop;
  const lastNew = msgs[msgs.length - 1];
  const sentByMe = !!lastNew && lastNew.uid === S.me.uid && c.lastId && lastNew.id !== c.lastId;   // net zelf verstuurd: altijd naar onder
  const shown = c.shown || (c.shown = new Set());
  loadProfiles(msgs.flatMap(m => [m.uid, ...(m.mentions?.users || [])]));
  list.replaceChildren();
  if (c.hasMore) list.append(h('p', { class: 'older', text: 'Oudere berichten laden…' }));
  if (!msgs.length) list.append(h('p', { class: 'start', text: c.type === 'server' ? 'Dit is het begin van dit kanaal. Zeg hallo!' : 'Dit is het begin van jullie gesprek. Zeg hallo!' }));

  const lastMine = [...msgs].reverse().find(x => x.uid === S.me.uid);
  let prev = null;
  for (const m of msgs) {
    const d = m.createdAt?.toDate?.() || new Date();
    const newDay = !prev || dayKey(prev.d) !== dayKey(d);
    if (newDay) list.append(h('div', { class: 'day', text: dayLabel(d) }));
    const grouped = !newDay && prev.uid === m.uid && d - prev.d < 5 * 60000;
    const mine = m.uid === S.me.uid;
    const srv = c.type === 'server' ? serverInfo(c.id) : null, pinged = !mine && srv && mentionsMe(srv, m);
    list.append(h('div', { class: `msg ${mine ? 'mine' : 'theirs'}${grouped ? ' grouped' : ''}${pinged ? ' mention-me mk-' + pinged : ''}${!c.first && !c.anchor && !shown.has(m.id) ? ' new' : ''}`, 'data-mid': m.id },
      !mine && h('div', { class: 'msg-av' }, grouped ? null : avatar(m.uid, PROF[m.uid]?.username || m.name, 34, true)),
      h('div', { class: 'msg-body' },
        !grouped && h('div', { class: 'meta' }, !mine && h('b', { text: PROF[m.uid]?.username || m.name || 'Onbekend', style: srv ? roleColorStyle(srv, m.uid) : null }), srv ? rankTag(srv, m.uid) : null, h('time', { text: tf.format(d) })),
        h('div', { class: 'bwrap' },
          h('div', { class: 'bubble' }, m.fwd ? h('span', { class: 'fwd', html: I.fwd + 'Doorgestuurd' }) : null, m.replyTo ? quoteEl(m.replyTo) : null, srv ? mentionNodes(srv, m) : m.text, m.editedAt ? h('small', { class: 'edited', text: ' (bewerkt)' }) : null),
          h('button', { class: 'icon-btn emo-btn', type: 'button', title: 'Emoji reageren', 'aria-label': 'Emoji reageren', html: I.smile,
            onclick: ev => { ev.stopPropagation(); const r = ev.currentTarget.getBoundingClientRect(); openPicker(m, r.left, r.bottom + 6); } }),
          !mine && h('button', { class: 'icon-btn react-btn', type: 'button', title: 'Reageren', 'aria-label': 'Reageren op dit bericht', html: I.reply, onclick: () => startReply(m) }),
          reactionsEl(m)),
        mine ? h('div', { class: 'receipt', 'data-mid': m.id }) : null)));
    prev = { uid: m.uid, d };
    shown.add(m.id);
  }
  if (c.anchor) {   // oudere berichten erbij: blijf op dezelfde plek staan
    list.scrollTop = c.anchor.t + (list.scrollHeight - c.anchor.h);
    c.anchor = null; c.loadingMore = false;
  } else if (nearBottom || sentByMe) {
    const down = () => { list.scrollTop = list.scrollHeight; };
    down(); requestAnimationFrame(down);
  } else list.scrollTop = keepTop;
  c.first = false;

  const last = msgs[msgs.length - 1];
  S.chat.newest = last ? { id: last.id, uid: last.uid, ver: last.editedAt?.toMillis?.() || 0 } : null;
  S.chat.lastMillis = last?.createdAt?.toMillis?.() || 0;
  S.chat.lastMineAt = lastMine?.createdAt?.toMillis?.() || 0;
  S.chat.byId = Object.fromEntries(msgs.map(x => [x.id, x]));
  // oplopend. Alleen het allernieuwste bericht van het gesprek telt na een bewerking opnieuw (editedAt): dan gaat het oogje
  // terug naar het vorige bericht tot de lezer het aangepaste bericht weer heeft gelezen.
  S.chat.mine = msgs.filter(x => x.uid === S.me.uid).map(x => ({ id: x.id, ms: (x.id === last?.id && x.editedAt?.toMillis?.()) || x.createdAt?.toMillis?.() || Date.now() }));
  markRead(); updateReceipt(); seenOpenDm();
  if (last && last.id !== S.chat.lastId) {
    if (S.chat.lastId && last.uid !== S.me.uid) delete S.chat.seen[last.uid];
    S.chat.lastId = last.id;
    renderTyping();
  }
}

async function sendMessage(text, reply, fwd = false, target = S.chat) {
  const c = target; if (!c) return;
  const batch = writeBatch(db);
  const data = { uid: S.me.uid, name: S.profile?.username || 'Onbekend', text, createdAt: serverTimestamp() };
  if (c.type === 'server' && !fwd) { const mn = await parseMentions(serverInfo(c.id), text); if (mn) data.mentions = mn; }
  if (fwd) data.fwd = true;
  if (reply) data.replyTo = { id: String(reply.id), uid: String(reply.uid), name: String(reply.name).slice(0, 20), text: String(reply.text).slice(0, 100) };
  const msgRef = doc(c.col);
  batch.set(msgRef, data);
  if (c.type === 'dm') {
    batch.set(doc(db, 'chats', c.id), { lastText: text.slice(0, 80), lastUid: S.me.uid, lastAt: serverTimestamp() }, { merge: true });
  }
  await batch.commit();
  pushPing(c.type === 'dm' ? { type: 'dm', chatId: c.id, mid: msgRef.id } : { type: 'server', sid: c.id, cid: c.cid || GENERAL, mid: msgRef.id });
}

function openForward(m) {
  const text = String(m.text || '');
  const rows = [];
  const send = async (type, id, name) => {
    let cid = null;
    if (type === 'server') { cid = sendableChannel(serverInfo(id)); if (!cid) { toast('Je mag in deze server nergens berichten sturen.'); return; } }
    const col = type === 'dm' ? collection(db, 'chats', id, 'messages') : chanMsgCol(id, cid);
    try { await sendMessage(text, null, true, { type, id, cid, col }); closeDialog(); toast('Doorgestuurd naar ' + name + '.'); }
    catch (e) { toast(fbErr(e)); }
  };
  for (const f of accepted()) {
    const n = otherName(f);
    rows.push(h('button', { class: 'item', type: 'button', onclick: () => send('dm', f.id, n) },
      dotted(otherId(f), n, 36), h('span', { class: 'item-text' }, h('b', { text: n }), h('small', { text: 'Direct bericht' }))));
  }
  for (const sv of [...S.servers].sort((a, b) => a.name.localeCompare(b.name))) {
    rows.push(h('button', { class: 'item', type: 'button', onclick: () => send('server', sv.id, sv.name) },
      avatar(sv.id, sv.name, 36), h('span', { class: 'item-text' }, h('b', { text: sv.name }), h('small', { text: 'Server' }))));
  }
  openDialog(
    h('h3', { text: 'Bericht doorsturen' }),
    h('p', { class: 'sub', text: snippet(text, 120) }),
    h('div', { class: 'fwd-list' }, rows.length ? rows : h('p', { class: 'hint', text: 'Je hebt nog geen chats om naar door te sturen.' })),
    h('div', { class: 'dlg-actions' }, h('button', { class: 'ghost', type: 'button', onclick: closeDialog, text: 'Annuleren' })));
}

async function deleteMessage(id) {
  try { await deleteDoc(doc(S.chat.col, id)); } catch (e) { toast(fbErr(e)); }
}

/* =====================  reageren, bewerken en het rechtermuisknop-menu  ===================== */
// Reageren = een bericht citeren (opgeslagen als `replyTo` in het nieuwe bericht). Bewerken kan alleen bij je eigen berichten
// (`text` + `editedAt`). Rechtermuisknop op een bericht: Reageren (alle berichten), Bewerken + Verwijderen (alleen van jou).
const snippet = (t, n = 100) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };

function paintCompose() {
  const bar = $('#cbar'), c = S.chat;
  if (!bar || !c) return;
  const x = h('button', { class: 'icon-btn', type: 'button', html: I.x, 'aria-label': 'Annuleren', onclick: cancelCompose });
  if (c.editing) {
    bar.replaceChildren(h('span', { class: 'cbar-ic', html: I.pencil }),
      h('span', { class: 'cbar-t' }, h('b', { text: 'Bericht bewerken' }), h('small', { text: 'Enter = opslaan · Esc = annuleren' })), x);
  } else if (c.replyTo) {
    bar.replaceChildren(h('span', { class: 'cbar-ic', html: I.reply }),
      h('span', { class: 'cbar-t' }, h('b', { text: 'Reageren op ' + c.replyTo.name }), h('small', { text: c.replyTo.text })), x);
  } else bar.replaceChildren();
  bar.hidden = !(c.editing || c.replyTo);
}
function cancelCompose() {
  const c = S.chat, ta = $('#msgInput');
  if (!c) return;
  if (c.editing && ta) { ta.value = ''; ta.style.height = 'auto'; }
  c.editing = null; c.replyTo = null; paintCompose();
}
function startReply(m) {
  const c = S.chat, ta = $('#msgInput');
  if (!c || !m) return;
  if (c.editing && ta) { ta.value = ''; ta.style.height = 'auto'; }
  c.editing = null;
  const name = m.uid === S.me.uid ? (S.profile?.username || m.name) : (PROF[m.uid]?.username || m.name);
  c.replyTo = { id: m.id, uid: m.uid, name: String(name || 'Onbekend').slice(0, 20), text: snippet(m.text) };
  paintCompose(); ta?.focus();
}
function startEdit(m) {
  const c = S.chat, ta = $('#msgInput');
  if (!c || !ta || !m || m.uid !== S.me.uid) return;
  c.replyTo = null; c.editing = m.id;
  ta.value = m.text; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  paintCompose(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
}
async function editMessage(id, text) {
  try { await updateDoc(doc(S.chat.col, id), { text, editedAt: serverTimestamp() }); }
  catch (e) { toast(fbErr(e)); }
}
function quoteEl(r) {
  return h('button', { class: 'quote', type: 'button', title: 'Naar het originele bericht', onclick: () => jumpTo(r.id) },
    h('b', { text: String(r.name || 'Onbekend') }), h('span', { class: 'quote-t', text: String(r.text || '') }));
}
function jumpTo(id) {
  const el = document.querySelector(`#msgList .msg[data-mid="${CSS.escape(String(id))}"]`);
  if (!el) { toast('Dat bericht staat te ver terug om te tonen.'); return; }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

let ctxEl = null;
function closeCtx() { ctxEl?.remove(); ctxEl = null; }
function openCtx(x, y, items) {
  closeCtx();
  ctxEl = h('div', { class: 'ctx', role: 'menu' }, items.map(it => h('button', {
    class: 'ctx-i' + (it.danger ? ' danger' : ''), type: 'button', role: 'menuitem',
    onclick: e => { e.stopPropagation(); closeCtx(); it.run(); }
  }, h('span', { class: 'ctx-ic', html: it.icon }), it.label)));
  document.body.append(ctxEl);
  const r = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  ctxEl.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  ctxEl.querySelector('button')?.focus();
}
document.addEventListener('click', closeCtx);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCtx(); });
window.addEventListener('resize', closeCtx);
document.addEventListener('scroll', closeCtx, true);
function showMsgMenu(el, x, y) {
  const m = S.chat?.byId?.[el.dataset.mid];
  if (!m) return false;
  const items = [
    { icon: I.reply, label: 'Reageren', run: () => startReply(m) },
    { icon: I.smile, label: 'Emoji reageren', run: () => openPicker(m, x, y) },
    { icon: I.copy, label: 'Bericht kopiëren', run: () => copyText(m.text) },
    { icon: I.fwd, label: 'Doorsturen', run: () => openForward(m) }
  ];
  if (m.uid === S.me.uid) items.push({ icon: I.pencil, label: 'Bewerken', run: () => startEdit(m) });
  if (m.uid === S.me.uid || canModerateHere()) items.push({ icon: I.trash, label: 'Verwijderen', danger: true, run: () => deleteMessage(m.id) });
  openCtx(x, y, items);
  return true;
}
document.addEventListener('contextmenu', e => {
  const el = e.target.closest?.('#msgList .msg');
  if (!el || !S.chat) { closeCtx(); return; }
  if (showMsgMenu(el, e.clientX, e.clientY)) e.preventDefault();
});
// telefoon: lang op een bericht drukken opent hetzelfde menu
{
  let t = 0, start = null, fired = 0;
  const cancel = () => { clearTimeout(t); t = 0; };
  document.addEventListener('touchstart', e => {
    const el = e.target.closest?.('#msgList .msg');
    if (!el || !S.chat || e.touches.length !== 1 || e.target.closest('button, a')) return;
    const p = e.touches[0]; start = { x: p.clientX, y: p.clientY };
    cancel();
    t = setTimeout(() => { if (showMsgMenu(el, start.x, start.y)) { fired = Date.now(); navigator.vibrate?.(15); } }, 450);
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    const p = e.touches[0];
    if (start && (Math.abs(p.clientX - start.x) > 10 || Math.abs(p.clientY - start.y) > 10)) cancel();
  }, { passive: true });
  document.addEventListener('touchend', e => { cancel(); if (Date.now() - fired < 800 && e.cancelable) e.preventDefault(); }, { passive: false });
  document.addEventListener('touchcancel', cancel, { passive: true });
}

async function copyText(t) {
  const text = String(t ?? '');
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0;top:0;left:0' }); ta.value = text;
    document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }
  toast('Bericht gekopieerd.');
}

/* =====================  emoji-reacties  ===================== */
// Opgeslagen op het berichtdocument: reactions = { [uid]: ['up','heart', ...] }. Tellen doet de client.
const REACTS = { up: '👍', heart: '❤️', laugh: '😂', wow: '😮', sad: '😢', fire: '🔥', party: '🎉', eyes: '👀' };
let pickEl = null;
function closePicker() { pickEl?.remove(); pickEl = null; }
document.addEventListener('click', e => { if (pickEl && !pickEl.contains(e.target)) closePicker(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePicker(); });
document.addEventListener('scroll', closePicker, true);
function openPicker(m, x, y) {
  closeCtx(); closePicker();
  const mine = m.reactions?.[S.me.uid] || [];
  pickEl = h('div', { class: 'rpick', role: 'menu' }, Object.entries(REACTS).map(([k, em]) => h('button', {
    class: 'rpick-b' + (mine.includes(k) ? ' on' : ''), type: 'button', text: em, 'aria-label': 'Reageer met ' + em,
    onclick: ev => { ev.stopPropagation(); closePicker(); toggleReaction(m, k); }
  })));
  document.body.append(pickEl);
  const r = pickEl.getBoundingClientRect();
  pickEl.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  pickEl.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
}
async function toggleReaction(m, key) {
  const c = S.chat, me = S.me.uid; if (!c || !REACTS[key]) return;
  const cur = Array.isArray(m.reactions?.[me]) ? m.reactions[me] : [];
  const next = cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key];
  try { await updateDoc(doc(c.col, m.id), { [`reactions.${me}`]: next.length ? next : deleteField() }); }
  catch (e) { toast(fbErr(e)); }
}
function reactionsEl(m) {
  const counts = {};
  for (const arr of Object.values(m.reactions || {})) if (Array.isArray(arr)) for (const k of arr) if (REACTS[k]) counts[k] = (counts[k] || 0) + 1;
  const keys = Object.keys(REACTS).filter(k => counts[k]);
  if (!keys.length) return null;
  const mine = m.reactions?.[S.me.uid] || [];
  return h('div', { class: 'reacts' }, keys.map(k => h('button', {
    class: 'react' + (mine.includes(k) ? ' on' : ''), type: 'button', title: counts[k] + (counts[k] === 1 ? ' reactie' : ' reacties'),
    onclick: () => toggleReaction(m, k)
  }, h('span', { text: REACTS[k] }), counts[k] > 1 ? h('b', { text: String(counts[k]) }) : null)));
}

/* =====================  vrienden  ===================== */
async function addFriend(raw) {
  const name = raw.trim();
  if (!/^[A-Za-z0-9_.]{2,20}$/.test(name)) return { ok: false, text: 'Dat is geen geldige gebruikersnaam.' };
  const lower = name.toLowerCase();
  if (lower === S.profile?.usernameLower) return { ok: false, text: 'Jezelf toevoegen gaat helaas niet.' };
  try {
    const u = await getDoc(doc(db, 'usernames', lower));
    if (!u.exists()) return { ok: false, text: 'Geen gebruiker gevonden met die naam.' };
    const other = u.data().uid;
    const prof = await getDoc(doc(db, 'users', other));
    if (!prof.exists()) return { ok: false, text: 'Geen gebruiker gevonden met die naam.' };
    const id = pairId(S.me.uid, other);
    const ex = S.friendships.find(f => f.id === id);
    if (ex?.status === 'accepted') return { ok: false, text: 'Jullie zijn al vrienden.' };
    if (ex) return { ok: false, text: ex.requester === S.me.uid ? 'Je hebt al een verzoek gestuurd.' : 'Die persoon heeft jou al een verzoek gestuurd — kijk bij Requests.' };
    const [a, b] = [S.me.uid, other].sort();
    await setDoc(doc(db, 'friendships', id), {
      users: [a, b], requester: S.me.uid, status: 'pending',
      names: { [S.me.uid]: S.profile.username, [other]: prof.data().username },
      createdAt: serverTimestamp()
    });
    pushPing({ type: 'friend', id });
    return { ok: true, text: `Verzoek verstuurd naar ${prof.data().username}!` };
  } catch (e) { return { ok: false, text: fbErr(e) }; }
}

function renderFriends() {
  const inp = h('input', { class: 'inp', id: 'addInp', maxlength: 20, placeholder: 'Gebruikersnaam toevoegen…', autocomplete: 'off' });
  const msg = h('p', { class: 'note' });
  const go = async () => {
    msg.className = 'note'; msg.textContent = '';
    const r = await addFriend(inp.value);
    msg.textContent = r.text; msg.className = 'note ' + (r.ok ? 'ok' : 'bad');
    if (r.ok) inp.value = '';
  };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  $('#main').replaceChildren(h('div', { class: 'pane' },
    h('h2', { text: 'Vrienden' }),
    h('p', { class: 'sub', text: 'Voeg iemand toe met zijn of haar gebruikersnaam.' }),
    h('div', { class: 'addrow' }, inp, h('button', { class: 'glow', type: 'button', onclick: go, text: 'Verzoek sturen' })),
    msg,
    h('h3', { class: 'sec', id: 'friendCount' }),
    h('div', { id: 'friendList' })));
  renderFriendList();
}

function renderFriendList() {
  const box = $('#friendList'); if (!box) return;
  const fr = [...accepted()].sort((a, b) => otherName(a).localeCompare(otherName(b)));
  $('#friendCount').textContent = `Alle vrienden — ${fr.length}`;
  box.replaceChildren(...(fr.length ? fr.map(f => h('div', { class: 'row' },
    dotted(otherId(f), otherName(f), 42),
    h('span', { class: 'item-text' }, h('b', { text: otherName(f) }),
      h('small', { class: 'plabel', 'data-uid': otherId(f), text: LABEL[presState(otherId(f))] })),
    h('div', { class: 'row-actions' },
      h('button', {
        class: 'btn-ok', type: 'button', text: 'Bericht',
        onclick: () => { S.activeDm = f.id; S.tab = 'dms'; renderTabs(); renderSidebar(); showMain(); }
      }),
      h('button', {
        class: 'icon-btn', type: 'button', html: I.trash, title: 'Verwijderen', 'aria-label': 'Vriend verwijderen',
        onclick: async () => {
          if (!confirm(`${otherName(f)} verwijderen als vriend?`)) return;
          try { await deleteDoc(doc(db, 'friendships', f.id)); } catch (e) { toast(fbErr(e)); }
        }
      })))) : [h('p', { class: 'hint', text: 'Nog geen vrienden — stuur hierboven een verzoek.' })]));
}

function renderRequests() {
  $('#main').replaceChildren(h('div', { class: 'pane' },
    h('h2', { text: 'Verzoeken' }),
    h('p', { class: 'sub', text: 'Vriendschapsverzoeken die je hebt ontvangen of verstuurd.' }),
    h('h3', { class: 'sec', id: 'inCount' }), h('div', { id: 'reqIn' }),
    h('h3', { class: 'sec', id: 'outCount' }), h('div', { id: 'reqOut' })));
  renderRequestLists();
}

function renderRequestLists() {
  const rin = $('#reqIn'), rout = $('#reqOut'); if (!rin || !rout) return;
  const inc = incoming(), out = outgoing();
  loadProfiles([...inc, ...out].map(otherId));
  $('#inCount').textContent = `Binnenkomend — ${inc.length}`;
  $('#outCount').textContent = `Verstuurd — ${out.length}`;
  const empty = (t) => h('p', { class: 'hint', text: t });

  rin.replaceChildren(...(inc.length ? inc.map(f => h('div', { class: 'row' },
    avatar(otherId(f), otherName(f), 42, true),
    h('span', { class: 'item-text' }, h('b', { text: otherName(f) }), h('small', { text: 'wil vrienden worden' })),
    h('div', { class: 'row-actions' },
      h('button', {
        class: 'btn-ok', type: 'button', text: 'Accepteren',
        onclick: async () => { try { await updateDoc(doc(db, 'friendships', f.id), { status: 'accepted' }); toast(`Jij en ${otherName(f)} zijn nu vrienden!`); } catch (e) { toast(fbErr(e)); } }
      }),
      h('button', {
        class: 'btn-no', type: 'button', text: 'Weigeren',
        onclick: async () => { try { await deleteDoc(doc(db, 'friendships', f.id)); } catch (e) { toast(fbErr(e)); } }
      })))) : [empty('Geen binnenkomende verzoeken.')]));

  rout.replaceChildren(...(out.length ? out.map(f => h('div', { class: 'row' },
    avatar(otherId(f), otherName(f), 42, true),
    h('span', { class: 'item-text' }, h('b', { text: otherName(f) }), h('small', { text: 'wacht op antwoord' })),
    h('div', { class: 'row-actions' },
      h('button', {
        class: 'btn-no', type: 'button', text: 'Annuleren',
        onclick: async () => { try { await deleteDoc(doc(db, 'friendships', f.id)); } catch (e) { toast(fbErr(e)); } }
      })))) : [empty('Geen openstaande verzoeken.')]));
}

/* =====================  servers 2.0: kanalen, rollen, rechten en mentions  =====================
   Firestore:
   servers/{sid}  { name, icon, ownerId, members[], official, roles{id:{name,color,perms[],pos}}, permIdx{perm:[roleId]}, mroles{uid:[roleId]} }
     - `roles.everyone` is de rol die iedereen heeft; `permIdx` is een index (recht -> rollen) zodat de beveiligingsregels rechten kunnen controleren
     - de officiële server heeft id `official`; beheerd door iedereen met de moderator-badge
   servers/{sid}/channels/{cid}  { name, type: text|announce, pos, acl{view[],send[],manage[]} }   (acl-doelen: rol-id, 'u:<uid>' of 'everyone')
   Berichten: kanaal `general` staat op servers/{sid}/messages (zoals vroeger), andere kanalen op servers/{sid}/channels/{cid}/messages.
   Berichten met mentions hebben `mentions: { everyone, roles[], users[] }`. De Cloud Function maakt meldingen aan. */
const dlg = $('#dlg');
const openDialog = (...nodes) => { dlg.classList.remove('wide', 'plans', 'admin', 'bgs', 'srvset'); dlg.replaceChildren(h('div', { class: 'dlg-in' }, ...nodes)); if (!dlg.open) dlg.showModal(); };
const closeDialog = () => { if (dlg.open) dlg.close(); };
dlg.addEventListener('click', e => { if (e.target === dlg) closeDialog(); });

const OFFICIAL = 'official', GENERAL = 'general';
const PERMS = [
  ['admin', 'Beheerder', 'Alle rechten, ook in alle kanalen'],
  ['manageServer', 'Server beheren', 'Naam en icoon van de server wijzigen'],
  ['manageChannels', 'Kanalen beheren', 'Kanalen maken, hernoemen, ordenen, verwijderen en hun rechten instellen'],
  ['manageRoles', 'Rollen beheren', 'Rollen maken, aanpassen, verwijderen en toewijzen'],
  ['manageMessages', 'Berichten beheren', 'Berichten van anderen verwijderen'],
  ['kick', 'Leden verwijderen', 'Leden uit de server zetten'],
  ['mentionAll', '@everyone en rollen vermelden', 'Iedereen of een hele rol in één keer taggen']
];
const PERM_KEYS = PERMS.map(p => p[0]);
const ACL_KEYS = ['view', 'send', 'manage'];
const NAME_RE = /^[A-Za-z0-9_.\-]{1,20}$/;
const COLORS = ['#7c5cff', '#ff62d3', '#38bdf8', '#34d399', '#ffc857', '#fb923c', '#f87171', '#a3a3a3'];

const chanMsgCol = (sid, cid) => (!cid || cid === GENERAL) ? collection(db, 'servers', sid, 'messages') : collection(db, 'servers', sid, 'channels', cid, 'messages');
const defaultRoles = () => ({
  everyone: { name: 'everyone', color: '', perms: [], pos: 0 },
  r_admin: { name: 'Beheerder', color: '#ff62d3', perms: PERM_KEYS.slice(), pos: 90 },
  r_mod: { name: 'Moderator', color: '#38bdf8', perms: ['manageMessages', 'kick', 'mentionAll'], pos: 50 }
});
const buildIdx = (roles) => Object.fromEntries(PERM_KEYS.map(p => [p, Object.entries(roles).filter(([, r]) => (r.perms || []).includes(p)).map(([id]) => id)]));
const rolesOf = (s) => ({ everyone: defaultRoles().everyone, ...(s.roles || {}) });

/* --- rechten (dezelfde logica staat in firestore.rules; de regels zijn leidend) --- */
const isSupUid = (s, uid) => s.official
  ? BADGES.some(b => (b.id === 'moderator' || b.id === 'admin') && Array.isArray(b.users) && b.users.includes(uid))
  : s.ownerId === uid;
const srvSuper = (s) => !!s && isSupUid(s, S.me.uid);
const heldRoles = (s, uid) => ((s.mroles && s.mroles[uid]) || []).filter(r => s.roles?.[r] && r !== 'everyone');
const myRoleIds = (s, uid = S.me.uid) => [...heldRoles(s, uid), 'everyone'];
const hasPerm = (s, p, uid = S.me.uid) => !!s && (isSupUid(s, uid) || myRoleIds(s, uid).some(r => (s.permIdx?.[p] || []).includes(r) || (s.permIdx?.admin || []).includes(r)));
const anyManage = (s) => ['manageServer', 'manageChannels', 'manageRoles', 'kick'].some(p => hasPerm(s, p));
const topPos = (s, uid) => isSupUid(s, uid) ? Infinity : Math.max(0, ...heldRoles(s, uid).map(r => s.roles[r].pos || 0));
const topRole = (s, uid) => heldRoles(s, uid).map(r => s.roles[r]).sort((a, b) => (b.pos || 0) - (a.pos || 0))[0] || null;
const safeColor = (c) => HEX_RE.test(c || '') ? c : '';
const roleColorStyle = (s, uid) => { const c = safeColor(topRole(s, uid)?.color); return c ? `color:${c}` : null; };
function rankOf(s, uid) {
  if (isSupUid(s, uid)) return 'owner';
  if (hasPerm(s, 'admin', uid)) return 'admin';
  return ['manageServer', 'manageChannels', 'manageRoles', 'manageMessages', 'kick'].some(p => hasPerm(s, p, uid)) ? 'mod' : '';
}
const rankTag = (s, uid) => { const r = rankOf(s, uid); return r ? h('span', { class: 'rank rk-' + r, text: r === 'owner' ? (s.official ? 'Moderator' : 'Eigenaar') : r === 'admin' ? 'Beheerder' : 'Moderator' }) : null; };
const canActOn = (s, uid) => uid !== S.me.uid && !isSupUid(s, uid) && (srvSuper(s) || topPos(s, uid) < topPos(s, S.me.uid));

/* --- kanalen --- */
function chanList(s) {
  const list = [...(S.channels[s.id] || [])];
  if (!list.some(c => c.id === GENERAL)) list.push({ id: GENERAL, name: 'algemeen', type: 'text', pos: -1, virtual: true });
  return list.sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0) || String(a.name).localeCompare(String(b.name)));
}
function chanById(s, cid) {
  if (!s || !cid) return null;
  const c = chanList(s).find(x => x.id === cid);
  if (c) return c;
  return S.channels[s.id] === undefined && s.id === S.activeServer ? { id: cid, name: '…', type: 'text', pending: true } : null;   // kanalen nog niet geladen
}
const aclHit = (s, list) => Array.isArray(list) && list.some(t => t === 'everyone' || t === 'u:' + S.me.uid || myRoleIds(s).includes(t));
const canView = (s, ch) => hasPerm(s, 'admin') || !ch.acl?.view || aclHit(s, ch.acl.view);
const canSend = (s, ch) => hasPerm(s, 'admin') || (canView(s, ch) && (!ch.acl?.send || aclHit(s, ch.acl.send)));
const canMod = (s, ch) => hasPerm(s, 'manageMessages') || aclHit(s, ch.acl?.manage);
const sendableChannel = (s) => { const l = chanList(s).filter(c => canSend(s, c)); return (l.find(c => c.id === GENERAL) || l[0])?.id || null; };
function canModerateHere() { const c = S.chat; if (c?.type !== 'server') return false; const s = serverInfo(c.id), ch = chanById(s, c.cid); return !!s && !!ch && canMod(s, ch); }

function syncChannels() {
  const sid = S.activeServer;
  if (S.channelsFor === sid) return;
  S.unsub.channels?.(); S.unsub.channels = null; S.channelsFor = sid;
  if (!sid) return;
  S.unsub.channels = watch('kanalen', collection(db, 'servers', sid, 'channels'), snap => {
    S.channels[sid] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    chanChanged();
  });
}
function chanChanged() {
  const s = serverInfo(S.activeServer); scheduleSidebar();
  if (!s || S.tab !== 'servers') { ssView?.render(); return; }
  if (S.activeChannel) {
    const ch = chanById(s, S.activeChannel);
    if (!ch || !canView(s, ch)) { S.activeChannel = null; showMain(); }
    else if (S.chat?.type !== 'server' || S.chat.cid !== S.activeChannel) showMain();
    else srvChanged();
  } else autoPickChannel();
  ssView?.render();
}
function autoPickChannel() {
  const s = serverInfo(S.activeServer);
  if (!s || S.activeChannel || S.tab !== 'servers' || S.channels[s.id] === undefined || !matchMedia('(min-width: 801px)').matches) return;
  const ch = chanList(s).find(c => canView(s, c));
  if (ch) { S.activeChannel = ch.id; renderSidebar(); showMain(); }
}
// de serverdocument is veranderd (rollen, naam, leden): kop, invoer en rechten bijwerken
function srvChanged() {
  const c = S.chat; if (c?.type !== 'server') return;
  const s = serverInfo(c.id); if (!s) return;
  const ch = chanById(s, c.cid);
  if (!ch || !canView(s, ch)) { S.activeChannel = null; showMain(); return; }
  $('#chatHead')?.replaceWith(buildHead('server', c.id));
  applyComposerAccess();
  if (c.byId) renderMessages(Object.values(c.byId).sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0)));
  ssView?.render();
}
function applyComposerAccess() {
  const c = S.chat; if (c?.type !== 'server') return;
  const s = serverInfo(c.id), ch = chanById(s, c.cid), ta = $('#msgInput'); if (!s || !ch || !ta) return;
  const ok = canSend(s, ch);
  ta.disabled = !ok;
  ta.placeholder = ok ? `Bericht in #${ch.name}` : 'Je mag in dit kanaal geen berichten sturen.';
  $('.composer')?.classList.toggle('locked', !ok);
  const b = $('.composer .send'); if (b) b.disabled = !ok;
}

/* --- zijbalk --- */
function srvAvatar(s, size = 40) {
  const ic = safeImg(s.icon);
  return ic ? h('span', { class: 'avatar', style: `--s:${size}px;background:center / cover no-repeat url("${ic}")` }) : avatar(s.id, s.name, size);
}
function selectServer(id) {
  S.activeServer = id; S.activeChannel = null; syncChannels();
  renderSidebar(); showMain();
}
function fillServerSidebar(list, foot) {
  $('#sideTitle').textContent = 'Servers';
  const servers = [...S.servers].sort((a, b) => (b.official ? 1 : 0) - (a.official ? 1 : 0) || a.name.localeCompare(b.name));
  if (!servers.length) list.append(h('p', { class: 'hint', text: 'Je zit nog in geen enkele server. Maak er een of join met een code.' }));
  else list.append(h('div', { class: 'srv-rail' }, servers.map(s => h('button', {
    class: 'srv-ic' + (S.activeServer === s.id ? ' active' : ''), type: 'button', title: s.name, 'aria-label': s.name, onclick: () => selectServer(s.id)
  }, srvAvatar(s, 46), s.official ? h('i', { class: 'srv-star', html: I.star }) : null))));
  const s = serverInfo(S.activeServer);
  if (s) {
    const n = s.members.length;
    list.append(h('div', { class: 'srv-head' },
      h('span', { class: 'item-text' }, h('b', { text: s.name }), h('small', { text: `${n} ${n === 1 ? 'lid' : 'leden'}${s.official ? ' · Officieel' : ''}` })),
      anyManage(s) ? h('button', { class: 'icon-btn', type: 'button', html: I.gear, title: 'Serverinstellingen', 'aria-label': 'Serverinstellingen', onclick: () => openServerSettings() }) : null));
    for (const ch of chanList(s)) {
      if (!canView(s, ch)) continue;
      list.append(h('button', { class: 'item chan' + (S.activeChannel === ch.id ? ' active' : ''), type: 'button', onclick: () => { S.activeChannel = ch.id; renderSidebar(); showMain(); } },
        h('span', { class: 'ch-ic', html: ch.type === 'announce' ? I.megaphone : I.hash }),
        h('span', { class: 'item-text' }, h('b', { text: ch.name })),
        ch.acl?.view ? h('span', { class: 'ch-lock', html: I.lock, title: 'Beperkte rechten' }) : null));
    }
    if (hasPerm(s, 'manageChannels')) list.append(h('button', { class: 'ghost sm chan-add', type: 'button', html: I.plus + '<span>Kanaal maken</span>', onclick: () => openServerSettings('channels', { kind: 'chan', id: null }) }));
  }
  foot.append(
    h('button', { class: 'glow', type: 'button', onclick: openCreateServer, html: I.plus + 'Server maken' }),
    h('button', { class: 'ghost', type: 'button', onclick: openJoinServer, text: 'Joinen met code' }));
}

/* --- servers maken, joinen, verlaten, verwijderen + de officiële server --- */
const newServerDoc = (name) => { const roles = defaultRoles(); return { name, ownerId: S.me.uid, members: [S.me.uid], createdAt: serverTimestamp(), roles, permIdx: buildIdx(roles), mroles: {} }; };
function openCreateServer() {
  const inp = h('input', { class: 'inp', maxlength: 30, placeholder: 'Naam van de server' });
  const err = h('p', { class: 'err' });
  const go = async () => {
    const name = inp.value.trim();
    if (!name) { err.textContent = 'Geef de server een naam.'; return; }
    try {
      const ref = await addDoc(collection(db, 'servers'), newServerDoc(name));
      closeDialog(); S.activeServer = ref.id; S.activeChannel = null; syncChannels(); renderSidebar(); showMain();
    } catch (e) { err.textContent = fbErr(e); }
  };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  openDialog(h('h3', { text: 'Server maken' }), h('p', { class: 'sub', text: 'Een eigen plek met kanalen en rollen. Je krijgt automatisch een kanaal #algemeen en de rollen Beheerder en Moderator.' }), inp, err,
    h('div', { class: 'dlg-actions' }, h('button', { class: 'ghost', type: 'button', onclick: closeDialog, text: 'Annuleren' }), h('button', { class: 'glow', type: 'button', onclick: go, text: 'Maken' })));
  inp.focus();
}
function openJoinServer() {
  const inp = h('input', { class: 'inp', placeholder: 'Plak de uitnodigingscode', autocomplete: 'off' });
  const err = h('p', { class: 'err' });
  const go = async () => {
    const code = inp.value.trim();
    if (!code || code.includes('/')) { err.textContent = 'Dat is geen geldige code.'; return; }
    if (S.servers.some(s => s.id === code)) { err.textContent = 'Je zit al in deze server.'; return; }
    try {
      await updateDoc(doc(db, 'servers', code), { members: arrayUnion(S.me.uid) });
      closeDialog(); S.activeServer = code; S.activeChannel = null; syncChannels(); renderSidebar(); showMain();
    } catch (e) { err.textContent = /permission|not-found/.test(e.code || '') ? 'Ongeldige code.' : fbErr(e); }
  };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  openDialog(h('h3', { text: 'Joinen met code' }), h('p', { class: 'sub', text: 'Vraag de eigenaar van de server om de uitnodigingscode.' }), inp, err,
    h('div', { class: 'dlg-actions' }, h('button', { class: 'ghost', type: 'button', onclick: closeDialog, text: 'Annuleren' }), h('button', { class: 'glow', type: 'button', onclick: go, text: 'Joinen' })));
  inp.focus();
}
async function leaveServer(s) {
  if (s.official || !confirm(`Server "${s.name}" verlaten?`)) return;
  try { await updateDoc(doc(db, 'servers', s.id), { members: arrayRemove(S.me.uid), [`mroles.${S.me.uid}`]: deleteField() }); }
  catch (e) { toast(fbErr(e)); }
}
async function deleteServer(s) {
  if (s.official || !confirm(`Server "${s.name}" voor iedereen verwijderen?`)) return;
  try {
    const batch = writeBatch(db);
    for (const c of (S.channels[s.id] || [])) batch.delete(doc(db, 'servers', s.id, 'channels', c.id));
    batch.delete(doc(db, 'servers', s.id));
    await batch.commit(); closeDialog();
  } catch (e) { toast(fbErr(e)); }
}
// Iedereen is automatisch lid van de officiële server. Bestaat hij nog niet, dan maakt de eerste moderator die inlogt hem aan.
async function ensureOfficial() {
  if (!S.me || S.servers.some(x => x.id === OFFICIAL) || S.officialTried === 'busy') return;
  const prev = S.officialTried;
  if (!prev) {
    S.officialTried = 'busy';
    try { await updateDoc(doc(db, 'servers', OFFICIAL), { members: arrayUnion(S.me.uid) }); S.officialTried = 'done'; return; }
    catch (e) { S.officialTried = 'missing'; }
  }
  if (isAdmin() && BADGES.length && S.officialTried === 'missing') {
    S.officialTried = 'busy';
    try {
      await setDoc(doc(db, 'servers', OFFICIAL), { ...newServerDoc('Infinitum'), official: true });
      await setDoc(doc(db, 'servers', OFFICIAL, 'channels', 'nieuws'), { name: 'nieuws', type: 'announce', pos: 1, acl: { send: [] }, createdAt: serverTimestamp() });
      S.officialTried = 'done';
    } catch (e) { console.error('Officiële server aanmaken mislukt', e); S.officialTried = 'missing'; }
  } else if (S.officialTried === 'missing') {
    // bestaat de officiële server nog niet, dan niet elke minuut een (mislukte) schrijfactie doen: steeds langer wachten, max. 15 min
    S.officialDelay = Math.min((S.officialDelay || 30000) * 2, 900000);
    setTimeout(() => { if (S.me && S.officialTried === 'missing') { S.officialTried = false; ensureOfficial(); } }, S.officialDelay);
  }
}

/* --- mentions --- */
const MN_RE = /@([A-Za-z0-9_.\-]+)/g;
// Alle @vermeldingen in een tekst. Een punt of streepje aan het eind hoort bij de zin ("Hoi @henk.") en niet bij de naam:
// elke vermelding heeft daarom een lijst `cands` met de volledige en de ingekorte naam (langste eerst).
// Een @ midden in een woord (bijv. een e-mailadres) telt niet.
function mentionTokens(text) {
  const out = [];
  for (const x of String(text || '').matchAll(MN_RE)) {
    if (x.index > 0 && /[A-Za-z0-9_.\-]/.test(text[x.index - 1])) continue;
    const full = x[1], short = full.replace(/[.\-]+$/, '');
    const cands = [full.toLowerCase()];
    if (short && short !== full) cands.push(short.toLowerCase());
    out.push({ start: x.index, cands, lens: [x[0].length, short ? short.length + 1 : 0] });
  }
  return out;
}
function mentionsMe(s, m) {
  const mn = m?.mentions; if (!s || !mn) return '';
  if (mn.users?.includes(S.me.uid)) return 'user';
  if (mn.roles?.some(r => myRoleIds(s).includes(r))) return 'role';
  return mn.everyone ? 'all' : '';
}
const roleIdByName = (s, l) => Object.keys(s.roles || {}).find(r => r !== 'everyone' && String(s.roles[r].name || '').toLowerCase() === l);
function mentionNodes(s, m) {
  const mn = m.mentions, text = String(m.text || '');
  if (!mn) return text;
  const users = {};
  for (const u of mn.users || []) { const n = PROF[u]?.username || NAME[u]; if (n) users[n.toLowerCase()] = u; }
  const out = []; let last = 0;
  for (const t of mentionTokens(text)) {
    if (t.start < last) continue;
    let node = null, len = 0;
    for (let i = 0; i < t.cands.length && !node; i++) {
      const l = t.cands[i];
      if (l === 'everyone' && mn.everyone) node = h('span', { class: 'mn mn-all', text: '@' + l });
      else {
        const rid = (mn.roles || []).find(r => s.roles?.[r] && String(s.roles[r].name || '').toLowerCase() === l);
        if (rid) node = h('span', { class: 'mn mn-role', style: safeColor(s.roles[rid].color) ? `--rc:${s.roles[rid].color}` : null, text: '@' + l });
        else if (users[l]) node = h('span', { class: 'mn mn-user' + (users[l] === S.me.uid ? ' me' : ''), text: '@' + l });
      }
      if (node) len = t.lens[i];
    }
    if (!node) continue;
    // de tekst zoals de afzender hem typte (hoofdletters) tonen
    node.textContent = text.slice(t.start, t.start + len);
    if (t.start > last) out.push(text.slice(last, t.start));
    out.push(node); last = t.start + len;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
const UNAME = new Map();   // gebruikersnaam (klein) -> uid, zodat dezelfde naam niet steeds opnieuw wordt opgezocht
async function uidByName(s, l) {
  for (const u of s.members) if ((PROF[u]?.username || NAME[u] || '').toLowerCase() === l) return u;
  if (!/^[a-z0-9_.]{2,20}$/.test(l)) return null;   // zo'n gebruikersnaam kan niet bestaan: geen lees-actie nodig
  let u = UNAME.get(l);
  if (u === undefined) {
    try { const d = await getDoc(doc(db, 'usernames', l)); u = d.exists() ? d.data().uid : null; UNAME.set(l, u); } catch { return null; }
  }
  return u && s.members.includes(u) ? u : null;
}
async function parseMentions(s, text) {
  if (!s || !text.includes('@')) return null;
  const mn = { everyone: false, roles: [], users: [] }, all = hasPerm(s, 'mentionAll');
  const seen = new Set();
  for (const t of mentionTokens(text).slice(0, 24)) {
    for (const l of t.cands) {
      if (seen.has(l)) break;
      let hit = false;
      if (l === 'everyone') { if (all) { mn.everyone = true; hit = true; } }
      else {
        const rid = all ? roleIdByName(s, l) : null;   // zonder het recht is `@rolnaam` gewone tekst (maar `@gebruikersnaam` werkt wel)
        if (rid) { if (mn.roles.length < 10 && !mn.roles.includes(rid)) mn.roles.push(rid); hit = true; }
        else {
          const u = await uidByName(s, l);
          if (u && u !== S.me.uid) { if (mn.users.length < 20 && !mn.users.includes(u)) mn.users.push(u); hit = true; }
        }
      }
      if (hit) { seen.add(l); break; }
    }
  }
  return mn.everyone || mn.roles.length || mn.users.length ? mn : null;
}
// automatisch aanvullen na een @
function mentionSuggest(ta) {
  const pop = $('#mnPop'), s = serverInfo(S.chat?.id); if (!pop || !s) return;
  const m = ta.value.slice(0, ta.selectionStart).match(/(?:^|\s)@([A-Za-z0-9_.\-]*)$/);
  if (!m) { pop.hidden = true; return; }
  const q = m[1].toLowerCase(), items = [];
  if (hasPerm(s, 'mentionAll')) {
    if ('everyone'.startsWith(q)) items.push({ label: 'everyone', sub: 'Iedereen in deze server', cls: 'mn-all' });
    for (const [id, r] of Object.entries(s.roles || {})) if (id !== 'everyone' && r.name.toLowerCase().startsWith(q)) items.push({ label: r.name, sub: 'Rol', cls: 'mn-role', color: safeColor(r.color) });
  }
  for (const u of s.members) {
    if (items.length >= 8) break;
    const n = PROF[u]?.username || NAME[u];
    if (n && u !== S.me.uid && n.toLowerCase().startsWith(q)) items.push({ label: n, sub: 'Lid', cls: 'mn-user' });
  }
  if (!items.length) { pop.hidden = true; return; }
  pop._items = items.slice(0, 8); pop._idx = 0; pop._start = ta.selectionStart - m[1].length - 1; pop._ta = ta;
  paintPop(pop);
}
function paintPop(pop) {
  pop.replaceChildren(...pop._items.map((it, i) => h('button', { type: 'button', class: 'mn-opt' + (i === pop._idx ? ' on' : ''),
    onmousedown: (e) => { e.preventDefault(); pickMention(pop, i); } },
    h('span', { class: 'mn ' + it.cls, style: it.color ? `--rc:${it.color}` : null, text: '@' + it.label }), h('small', { text: it.sub }))));
  pop.hidden = false;
}
function pickMention(pop, i) {
  const ta = pop._ta, it = pop._items[i]; if (!ta || !it) return;
  const end = ta.selectionStart, ins = '@' + it.label + ' ';
  ta.value = ta.value.slice(0, pop._start) + ins + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = pop._start + ins.length; pop.hidden = true; ta.focus();
  ta.dispatchEvent(new Event('input'));
}
function mentionKey(e, ta) {
  const pop = $('#mnPop'); if (!pop || pop.hidden || !pop._items) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { pop._idx = (pop._idx + (e.key === 'ArrowDown' ? 1 : pop._items.length - 1)) % pop._items.length; paintPop(pop); e.preventDefault(); return true; }
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(pop, pop._idx); return true; }
  if (e.key === 'Escape') { pop.hidden = true; e.preventDefault(); return true; }
  return false;
}

/* --- ledenlijst (voor iedereen) --- */
async function openMembers() {
  const c = S.chat; if (c?.type !== 'server') return;
  const s0 = serverInfo(c.id); if (!s0) return;
  const rank = { online: 0, dnd: 1, idle: 2, offline: 3 }, grp = { owner: 0, admin: 1, mod: 2, '': 3 };
  const list = h('div', { class: 'mlist' });
  const render = () => {
    const s = serverInfo(c.id); if (!s) return;
    const rows = s.members.slice(0, 200).map(u => ({ u, n: NAME[u] || PROF[u]?.username || (u === S.me.uid ? S.profile?.username : '') || '…', st: presState(u), g: rankOf(s, u) }))
      .sort((a, b) => grp[a.g] - grp[b.g] || rank[a.st] - rank[b.st] || a.n.localeCompare(b.n));
    list.replaceChildren(...rows.map(r => h('div', { class: 'row', style: 'cursor:pointer', onclick: () => { closeDialog(); openProfile(r.u); } },
      dotted(r.u, r.n, 40),
      h('span', { class: 'item-text' }, h('b', { style: roleColorStyle(s, r.u), text: r.n + (r.u === S.me.uid ? ' (jij)' : '') }), r.u === S.me.uid || P.unsub[r.u] ? h('small', { class: 'plabel s-' + r.st, text: LABEL[r.st] }) : null),
      rankTag(s, r.u))));
  };
  membersView = { render };
  openDialog(h('h3', { text: 'Leden' }), h('p', { class: 'sub', text: s0.name + (s0.members.length > 200 ? ` · eerste 200 van ${s0.members.length}` : '') }), list,
    h('div', { class: 'dlg-actions' }, h('button', { class: 'ghost', type: 'button', onclick: closeDialog, text: 'Sluiten' })));
  render();
  await Promise.all(s0.members.slice(0, 200).map(nameOf));
  if (membersView) render();
}

/* --- serverinstellingen: overzicht, kanalen, rollen, leden --- */
let ssView = null;
const tgl = (label, sub, checked, on, disabled) => {
  const cb = h('input', { type: 'checkbox' }); cb.checked = !!checked; cb.disabled = !!disabled;
  cb.addEventListener('change', () => on(cb.checked));
  return h('label', { class: 'tog' }, h('span', { class: 'tog-text' }, h('b', { text: label }), sub ? h('small', { text: sub }) : null), cb, h('i'));
};
const roleChip = (s, rid) => { const r = s.roles?.[rid]; return r ? h('span', { class: 'rchip', style: safeColor(r.color) ? `--rc:${r.color}` : null, text: r.name }) : null; };

function openServerSettings(tab, sub) {
  const s = serverInfo(S.activeServer); if (!s || !anyManage(s)) return;
  const tabs = ssTabs(s);
  ssView = { sid: s.id, tab: tab && tabs.some(t => t[0] === tab) ? tab : tabs[0][0], sub: sub || null, q: '' };
  ssView.render = () => renderSS();
  openDialog(); dlg.classList.add('wide', 'srvset');
  renderSS();
}
const ssTabs = (s) => [
  hasPerm(s, 'manageServer') && ['overview', 'Overzicht'], hasPerm(s, 'manageChannels') && ['channels', 'Kanalen'],
  hasPerm(s, 'manageRoles') && ['roles', 'Rollen'], (hasPerm(s, 'kick') || hasPerm(s, 'manageRoles')) && ['members', 'Leden']
].filter(Boolean);
function renderSS() {
  if (!ssView) return;
  const s = serverInfo(ssView.sid);
  if (!s || !dlg.open) { ssView = null; return; }
  const tabs = ssTabs(s);
  if (!tabs.length) { closeDialog(); return; }
  if (!tabs.some(t => t[0] === ssView.tab)) ssView.tab = tabs[0][0];
  const body = ssView.sub ? (ssView.sub.kind === 'chan' ? ssChannelEditor(s, ssView.sub.id) : ssView.sub.kind === 'role' ? ssRoleEditor(s, ssView.sub.id) : ssMemberRoles(s, ssView.sub.id))
    : { overview: ssOverview, channels: ssChannels, roles: ssRoles, members: ssMembers }[ssView.tab](s);
  const sel = dlg.querySelector('.ss-body'), scroll = sel ? sel.scrollTop : 0;
  const viewKey = ssView.tab + '|' + (ssView.sub ? ssView.sub.kind + ':' + ssView.sub.id : ''), sameView = ssView.key === viewKey; ssView.key = viewKey;
  dlg.replaceChildren(h('div', { class: 'dlg-in' },
    h('h3', { text: 'Serverinstellingen' }), h('p', { class: 'sub', text: s.name }),
    ssView.sub ? null : h('div', { class: 'seg ss-seg', style: `grid-template-columns:repeat(${tabs.length},1fr)` }, tabs.map(([id, t]) => h('button', { type: 'button', class: id === ssView.tab ? 'active' : '', text: t, onclick: () => { ssView.tab = id; renderSS(); } }))),
    h('div', { class: 'ss-body' }, body),
    h('div', { class: 'dlg-actions' }, h('button', { class: 'ghost', type: 'button', text: ssView.sub ? 'Terug' : 'Sluiten', onclick: () => { if (ssView.sub) { ssView.sub = null; ssView.draft = null; renderSS(); } else closeDialog(); } }))));
  const nb = dlg.querySelector('.ss-body'); if (nb && sameView) nb.scrollTop = scroll;   // ook in de kanaal- en roleditor niet naar boven springen
}
const upd = async (s, data, ok) => { try { await updateDoc(doc(db, 'servers', s.id), data); if (ok) toast(ok); return true; } catch (e) { toast(fbErr(e)); return false; } };

function ssOverview(s) {
  const name = h('input', { class: 'inp', maxlength: 30, value: s.name });
  let icon = s.icon || '';
  const prev = h('span', { class: 'ss-icon' });
  const paint = () => prev.replaceChildren(srvAvatar({ ...s, icon }, 64));
  paint();
  const pick = async () => { const f = await pickFile(); if (!f) return; const r = await openCropper(f, 128, 128, { round: true, maxLen: 30000, title: 'Servericoon bijsnijden' }); if (r) { icon = r; paint(); } };
  const save = h('button', { class: 'glow', type: 'button', text: 'Opslaan', onclick: async () => {
    const n = name.value.trim(); if (!n) { toast('Geef de server een naam.'); return; }
    await upd(s, { name: n, icon: icon || deleteField() }, 'Server opgeslagen.');
  } });
  return h('div', {}, h('span', { class: 'set-lbl', text: 'Naam en icoon' }),
    h('div', { class: 'ss-row' }, prev, h('div', { class: 'ss-col' }, name, h('div', { class: 'ss-row' },
      h('button', { class: 'ghost sm', type: 'button', text: 'Icoon kiezen', onclick: pick }), h('button', { class: 'ghost sm', type: 'button', text: 'Icoon wissen', onclick: () => { icon = ''; paint(); } })))),
    h('div', { class: 'dlg-actions' }, save),
    h('span', { class: 'set-lbl', text: 'Uitnodigingscode' }),
    h('div', { class: 'ss-row' }, h('code', { class: 'ss-code', text: s.id }), h('button', { class: 'ghost sm', type: 'button', text: 'Kopiëren', onclick: async () => { try { await navigator.clipboard.writeText(s.id); toast('Code gekopieerd.'); } catch { toast('Code: ' + s.id); } } })),
    !s.official && s.ownerId === S.me.uid ? [h('span', { class: 'set-lbl', text: 'Gevaarlijk' }), h('button', { class: 'ghost sm danger', type: 'button', text: 'Server verwijderen', onclick: () => deleteServer(s) })] : null,
    s.official ? h('p', { class: 'hint', text: 'Dit is de officiële server: alleen gebruikers met de moderatorbadge beheren hem, en iedereen is er automatisch lid van.' }) : null);
}

async function saveChannelOrder(s, order) {
  try {
    const batch = writeBatch(db);
    order.forEach((c, i) => {
      const ref = doc(db, 'servers', s.id, 'channels', c.id);
      if (c.virtual) batch.set(ref, { name: c.name, type: c.type, pos: i, createdAt: serverTimestamp() });
      else if (c.pos !== i) batch.update(ref, { pos: i });
    });
    await batch.commit();
  } catch (e) { toast(fbErr(e)); }
}
function ssChannels(s) {
  const list = chanList(s);
  return h('div', {}, h('span', { class: 'set-lbl', text: 'Kanalen' }),
    list.map((c, i) => h('div', { class: 'ss-item' },
      h('span', { class: 'ch-ic', html: c.type === 'announce' ? I.megaphone : I.hash }),
      h('span', { class: 'item-text' }, h('b', { text: c.name }), h('small', { text: (c.type === 'announce' ? 'Aankondigingen' : 'Tekstkanaal') + (c.acl?.view ? ' · privé' : '') })),
      h('button', { class: 'icon-btn', type: 'button', html: I.up, disabled: i === 0, 'aria-label': 'Omhoog', onclick: () => { const o = [...list]; [o[i - 1], o[i]] = [o[i], o[i - 1]]; saveChannelOrder(s, o); } }),
      h('button', { class: 'icon-btn', type: 'button', html: I.down, disabled: i === list.length - 1, 'aria-label': 'Omlaag', onclick: () => { const o = [...list]; [o[i + 1], o[i]] = [o[i], o[i + 1]]; saveChannelOrder(s, o); } }),
      h('button', { class: 'icon-btn', type: 'button', html: I.pencil, 'aria-label': 'Bewerken', onclick: () => { ssView.sub = { kind: 'chan', id: c.id }; renderSS(); } }),
      c.id === GENERAL ? null : h('button', { class: 'icon-btn', type: 'button', html: I.trash, 'aria-label': 'Verwijderen', onclick: async () => {
        if (!confirm(`Kanaal #${c.name} verwijderen?`)) return;
        try { await deleteDoc(doc(db, 'servers', s.id, 'channels', c.id)); } catch (e) { toast(fbErr(e)); }
      } }))),
    h('div', { class: 'dlg-actions' }, h('button', { class: 'glow', type: 'button', html: I.plus + 'Kanaal maken', onclick: () => { ssView.sub = { kind: 'chan', id: null }; renderSS(); } })));
}

// naam -> rol of gebruiker (voor de kanaalrechten)
async function resolveTarget(s, raw) {
  const l = String(raw || '').trim().replace(/^@/, '').toLowerCase(); if (!l) return null;
  if (l === 'everyone') return { id: 'everyone', label: '@everyone' };
  const rid = Object.keys(s.roles || {}).find(r => r !== 'everyone' && s.roles[r].name.toLowerCase() === l);
  if (rid) return { id: rid, label: '@' + s.roles[rid].name };
  const u = await uidByName(s, l);
  return u ? { id: 'u:' + u, label: '@' + (PROF[u]?.username || NAME[u] || l) } : null;
}
const targetLabel = (s, t) => t === 'everyone' ? '@everyone' : t.startsWith('u:') ? '@' + (PROF[t.slice(2)]?.username || NAME[t.slice(2)] || 'gebruiker') : s.roles?.[t] ? '@' + s.roles[t].name : '@(verwijderde rol)';

function ssChannelEditor(s, cid) {
  const cur = cid ? chanList(s).find(c => c.id === cid) : null;
  const st = ssView.draft && ssView.draft.cid === cid ? ssView.draft : (ssView.draft = {
    cid, name: cur?.name || '', type: cur?.type || 'text',
    acl: { view: cur?.acl?.view ? [...cur.acl.view] : null, send: cur?.acl?.send ? [...cur.acl.send] : null, manage: cur?.acl?.manage ? [...cur.acl.manage] : null }
  });
  const name = h('input', { class: 'inp', maxlength: 30, value: st.name, placeholder: 'kanaalnaam', oninput: () => { st.name = name.value; } });
  const type = h('select', { class: 'inp', onchange: () => { st.type = type.value; if (st.type === 'announce' && st.acl.send === null && !cur) st.acl.send = []; renderSS(); } },
    h('option', { value: 'text', text: 'Tekstkanaal' }), h('option', { value: 'announce', text: 'Aankondigingen (alleen beheerders sturen)' }));
  type.value = st.type;
  const roleOpts = Object.entries(s.roles || {}).filter(([id]) => id !== 'everyone').sort((x, y) => (y[1].pos || 0) - (x[1].pos || 0));
  st.pend = st.pend || {};
  const permBlock = (key, title, offText, onText) => {
    const custom = st.acl[key] !== null, list = st.acl[key] || [];
    const sel = h('select', { class: 'inp', onchange: () => { st.acl[key] = sel.value === 'custom' ? [] : null; renderSS(); } },
      h('option', { value: 'all', text: offText }), h('option', { value: 'custom', text: onText }));
    sel.value = custom ? 'custom' : 'all';
    const add = h('input', { class: 'inp', value: st.pend[key] || '', placeholder: 'Los lid toevoegen: @gebruikersnaam + Enter', oninput: () => { st.pend[key] = add.value; }, onkeydown: async (e) => {
      if (e.key !== 'Enter') return; e.preventDefault();
      const t = await resolveTarget(s, add.value);
      if (!t || t.id === 'everyone') { toast('Geen lid of rol met die naam gevonden.'); return; }
      if (!st.acl[key].includes(t.id)) st.acl[key].push(t.id);
      st.pend[key] = ''; renderSS();
    } });
    const users = list.filter(t => t.startsWith('u:'));
    return h('div', { class: 'ss-perm' }, h('b', { text: title }), sel,
      custom ? [
        roleOpts.length ? h('small', { class: 'hint', text: 'Kies de rollen:' }) : h('small', { class: 'hint', text: 'Er zijn nog geen rollen; maak ze bij het tabblad Rollen.' }),
        roleOpts.map(([id, r]) => tgl(r.name, null, list.includes(id), (on) => { st.acl[key] = on ? [...new Set([...st.acl[key], id])] : st.acl[key].filter(x => x !== id); })),
        users.length ? h('div', { class: 'ss-chips' }, users.map(t => h('span', { class: 'rchip' }, targetLabel(s, t), h('button', { type: 'button', class: 'rchip-x', 'aria-label': 'Verwijderen', text: '×', onclick: () => { st.acl[key] = st.acl[key].filter(x => x !== t); renderSS(); } })))) : null,
        add] : null);
  };
  const save = h('button', { class: 'glow', type: 'button', text: cid ? 'Opslaan' : 'Maken', onclick: async () => {
    const nm = st.name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_\-äëïöüéèà]/g, '').slice(0, 30);
    if (!nm) { toast('Geef het kanaal een naam (letters, cijfers, - of _).'); return; }
    if (chanList(s).some(c => c.id !== cid && c.name === nm)) { toast('Die kanaalnaam bestaat al.'); return; }
    for (const k of ['view', 'send', 'manage']) {   // tekst die nog niet met Enter was toegevoegd, alsnog meenemen
      const raw = (st.pend[k] || '').trim();
      if (raw && st.acl[k] !== null) {
        const t = await resolveTarget(s, raw);
        if (!t || t.id === 'everyone') { toast(`“${raw}” is geen lid of rol van deze server.`); return; }
        if (!st.acl[k].includes(t.id)) st.acl[k].push(t.id);
      }
    }
    if (st.acl.view !== null && !st.acl.view.length && !confirm('Er is geen enkele rol of lid gekozen die dit kanaal mag zien: alleen beheerders zien het dan. Doorgaan?')) return;
    const acl = Object.fromEntries(Object.entries(st.acl).filter(([, v]) => v !== null));
    const hasAcl = Object.keys(acl).length > 0;
    try {
      const col = collection(db, 'servers', s.id, 'channels');
      if (!cid) await addDoc(col, { name: nm, type: st.type, pos: chanList(s).length + 1, ...(hasAcl ? { acl } : {}), createdAt: serverTimestamp() });
      else if (cur.virtual) await setDoc(doc(col, cid), { name: nm, type: st.type, pos: -1, ...(hasAcl ? { acl } : {}), createdAt: serverTimestamp() });
      else await updateDoc(doc(col, cid), { name: nm, type: st.type, acl: hasAcl ? acl : deleteField() });
      ssView.draft = null; ssView.sub = null; renderSS(); toast('Kanaal opgeslagen.');
    } catch (e) { toast(fbErr(e)); }
  } });
  return h('div', {}, h('span', { class: 'set-lbl', text: cid ? 'Kanaal bewerken' : 'Nieuw kanaal' }), name, type,
    h('span', { class: 'set-lbl', text: 'Rechten in dit kanaal' }),
    permBlock('view', 'Wie mag dit kanaal bekijken?', 'Alle leden', 'Alleen geselecteerde rollen/leden'),
    permBlock('send', 'Wie mag berichten sturen?', 'Alle leden die het kanaal zien', 'Alleen geselecteerde rollen/leden'),
    permBlock('manage', 'Wie mag berichten beheren (verwijderen)?', 'Alleen rollen met “Berichten beheren”', 'Ook geselecteerde rollen/leden'),
    h('div', { class: 'dlg-actions' }, save));
}

function ssRoles(s) {
  const roles = rolesOf(s), me = topPos(s, S.me.uid);
  const rows = Object.entries(roles).sort((a, b) => (b[1].pos || 0) - (a[1].pos || 0));
  const movable = rows.filter(([id, r]) => id !== 'everyone' && (srvSuper(s) || (r.pos || 0) < me));
  const swap = async (id, dir) => {
    const i = movable.findIndex(x => x[0] === id), j = i + dir; if (j < 0 || j >= movable.length) return;
    await upd(s, { [`roles.${movable[i][0]}.pos`]: movable[j][1].pos, [`roles.${movable[j][0]}.pos`]: movable[i][1].pos });
  };
  return h('div', {}, h('span', { class: 'set-lbl', text: 'Rollen' }),
    h('p', { class: 'hint', text: 'Hoger in de lijst = meer gezag. Je kunt alleen rollen beheren die lager staan dan jouw hoogste rol.' }),
    rows.map(([id, r]) => {
      const mv = movable.findIndex(x => x[0] === id), n = id === 'everyone' ? s.members.length : Object.values(s.mroles || {}).filter(a => a.includes(id)).length;
      const editable = id === 'everyone' ? hasPerm(s, 'manageRoles') : (srvSuper(s) || (r.pos || 0) < me);
      return h('div', { class: 'ss-item' },
        h('span', { class: 'rdot', style: safeColor(r.color) ? `background:${r.color}` : null }),
        h('span', { class: 'item-text' }, h('b', { text: id === 'everyone' ? '@everyone' : r.name }), h('small', { text: `${n} ${n === 1 ? 'lid' : 'leden'} · ${(r.perms || []).length} rechten` })),
        id !== 'everyone' && mv >= 0 ? [h('button', { class: 'icon-btn', type: 'button', html: I.up, disabled: mv === 0, 'aria-label': 'Omhoog', onclick: () => swap(id, -1) }),
          h('button', { class: 'icon-btn', type: 'button', html: I.down, disabled: mv === movable.length - 1, 'aria-label': 'Omlaag', onclick: () => swap(id, 1) })] : null,
        editable ? h('button', { class: 'icon-btn', type: 'button', html: I.pencil, 'aria-label': 'Bewerken', onclick: () => { ssView.sub = { kind: 'role', id }; renderSS(); } }) : null);
    }),
    h('div', { class: 'dlg-actions' }, h('button', { class: 'glow', type: 'button', html: I.plus + 'Rol maken', onclick: () => { ssView.sub = { kind: 'role', id: null }; renderSS(); } })));
}
function ssRoleEditor(s, rid) {
  const roles = rolesOf(s), cur = rid ? roles[rid] : null, isEv = rid === 'everyone';
  const st = ssView.draft && ssView.draft.rid === rid ? ssView.draft : (ssView.draft = { rid, name: cur?.name || '', color: safeColor(cur?.color) || COLORS[0], perms: [...(cur?.perms || [])] });
  const iAmAdmin = hasPerm(s, 'admin');
  const name = h('input', { class: 'inp', maxlength: 20, value: st.name, disabled: isEv, placeholder: 'rolnaam (zonder spaties)', oninput: () => { st.name = name.value; } });
  const color = h('input', { type: 'color', value: st.color, class: 'ss-color', onchange: () => { st.color = color.value; renderSS(); } });
  const save = h('button', { class: 'glow', type: 'button', text: rid ? 'Opslaan' : 'Maken', onclick: async () => {
    const nm = st.name.trim();
    if (!isEv && (!NAME_RE.test(nm) || ['everyone', 'here'].includes(nm.toLowerCase()))) { toast('Rolnaam: 1–20 tekens, letters/cijfers/_ . - (geen spaties), niet “everyone”.'); return; }
    if (Object.entries(roles).some(([id, r]) => id !== rid && r.name.toLowerCase() === nm.toLowerCase())) { toast('Die rolnaam bestaat al.'); return; }
    const id = rid || 'r_' + Math.random().toString(36).slice(2, 9);
    if (!rid && Object.keys(roles).length >= 24) { toast('Maximaal 24 rollen per server.'); return; }
    const role = { name: isEv ? 'everyone' : nm, color: isEv ? '' : st.color, perms: st.perms.filter(p => PERM_KEYS.includes(p)), pos: cur?.pos ?? 10 };
    const data = {};
    if (!rid) {
      // een nieuwe rol komt onderaan; alle rollen krijgen een eigen volgnummer zodat omhoog/omlaag schuiven altijd werkt
      // (vroeger kregen alle nieuwe rollen hetzelfde nummer en bleef schuiven zonder effect)
      const order = Object.entries(roles).filter(([r]) => r !== 'everyone').sort((a, b) => (b[1].pos || 0) - (a[1].pos || 0));
      order.push([id, role]);
      order.forEach(([r, x], i) => { const pos = (order.length - i) * 10; if (r === id) role.pos = pos; else if ((x.pos || 0) !== pos) data[`roles.${r}.pos`] = pos; });
    }
    const next = { ...roles, [id]: role };
    data[`roles.${id}`] = role; data.permIdx = buildIdx(next);
    if (await upd(s, data, 'Rol opgeslagen.')) { ssView.draft = null; ssView.sub = null; renderSS(); }
  } });
  const del = rid && !isEv ? h('button', { class: 'ghost sm danger', type: 'button', text: 'Rol verwijderen', onclick: async () => {
    if (!confirm(`Rol “${cur.name}” verwijderen? Leden raken deze rol kwijt.`)) return;
    const next = { ...roles }; delete next[rid];
    const data = { [`roles.${rid}`]: deleteField(), permIdx: buildIdx(next) };
    for (const [u, a] of Object.entries(s.mroles || {})) if (a.includes(rid)) { const f = a.filter(x => x !== rid); data[`mroles.${u}`] = f.length ? f : deleteField(); }
    if (await upd(s, data, 'Rol verwijderd.')) {
      ssView.draft = null; ssView.sub = null; renderSS();
      // de rol ook uit de kanaalrechten halen (anders blijft er een "verwijderde rol" staan); lukt dit niet (geen recht Kanalen beheren), dan is dat niet erg
      const hit = (S.channels[s.id] || []).filter(c => ACL_KEYS.some(k => c.acl?.[k]?.includes(rid)));
      if (hit.length) {
        try {
          const b = writeBatch(db);
          for (const c of hit) b.update(doc(db, 'servers', s.id, 'channels', c.id), { acl: Object.fromEntries(ACL_KEYS.filter(k => Array.isArray(c.acl?.[k])).map(k => [k, c.acl[k].filter(x => x !== rid)])) });
          await b.commit();
        } catch (e) { console.warn('Kanaalrechten opschonen mislukt', e); }
      }
    }
  } }) : null;
  return h('div', {}, h('span', { class: 'set-lbl', text: isEv ? 'Rechten van iedereen' : rid ? 'Rol bewerken' : 'Nieuwe rol' }),
    isEv ? h('p', { class: 'hint', text: '@everyone is iedereen in de server. Rechten die je hier aanzet, gelden voor alle leden.' }) : [name,
      h('div', { class: 'ss-row' }, color, COLORS.map(c => h('button', { type: 'button', class: 'ss-sw' + (c === st.color ? ' on' : ''), style: `background:${c}`, 'aria-label': c, onclick: () => { st.color = c; renderSS(); } })))],
    h('span', { class: 'set-lbl', text: 'Rechten' }),
    PERMS.map(([k, t, d]) => tgl(t, d, st.perms.includes(k), (on) => { st.perms = on ? [...new Set([...st.perms, k])] : st.perms.filter(x => x !== k); },
      k === 'admin' && !iAmAdmin ? true : false)),
    k_note(iAmAdmin), h('div', { class: 'dlg-actions' }, del, save));
}
const k_note = (a) => a ? null : h('p', { class: 'hint', text: 'Alleen een beheerder kan het recht “Beheerder” aan een rol geven of weghalen.' });

function ssMembers(s) {
  const q = (ssView.q || '').toLowerCase();
  const box = h('div', { class: 'mlist ss-mlist' });
  const search = h('input', { class: 'inp', placeholder: 'Zoek een lid op naam…', value: ssView.q || '', oninput: () => { ssView.q = search.value; fillRows(); } });
  const fillRows = async () => {
    const qq = (ssView.q || '').trim().toLowerCase();
    let uids = s.members.slice(0, 150);
    if (qq) {
      uids = s.members.filter(u => (PROF[u]?.username || NAME[u] || '').toLowerCase().includes(qq)).slice(0, 60);
      if (!uids.length && qq.length >= 2) { const u = await uidByName(s, qq); if (u) uids = [u]; }
    }
    await Promise.all(uids.map(nameOf));
    if (!box.isConnected && !box.parentNode) { /* dialoog is intussen vervangen */ }
    box.replaceChildren(...(uids.length ? uids : []).map(u => {
      const n = NAME[u] || PROF[u]?.username || '…', act = canActOn(s, u);
      return h('div', { class: 'row ss-mrow' }, dotted(u, n, 38),
        h('span', { class: 'item-text' }, h('b', { style: roleColorStyle(s, u), text: n + (u === S.me.uid ? ' (jij)' : '') }), h('span', { class: 'ss-chips' }, rankTag(s, u), heldRoles(s, u).map(r => roleChip(s, r)))),
        (act || srvSuper(s)) && hasPerm(s, 'manageRoles') ? h('button', { class: 'ghost sm', type: 'button', text: 'Rollen', onclick: () => { ssView.sub = { kind: 'mroles', id: u }; renderSS(); } }) : null,
        act && hasPerm(s, 'kick') && !s.official ? h('button', { class: 'ghost sm danger', type: 'button', text: 'Verwijderen', onclick: async () => {
          if (!confirm(`${n} uit de server zetten?`)) return;
          await upd(s, { members: arrayRemove(u), [`mroles.${u}`]: deleteField() }, n + ' is uit de server gezet.');
        } }) : null);
    }));
    if (!uids.length) box.replaceChildren(h('p', { class: 'hint', text: qq ? 'Geen lid gevonden.' : 'Geen leden.' }));
  };
  fillRows();
  return h('div', {}, h('span', { class: 'set-lbl', text: `Leden (${s.members.length})` }), search, box,
    s.members.length > 150 && !q ? h('p', { class: 'hint', text: 'De eerste 150 leden worden getoond; gebruik het zoekveld voor de rest.' }) : null);
}
function ssMemberRoles(s, uid) {
  const n = NAME[uid] || PROF[uid]?.username || 'lid', mine = topPos(s, S.me.uid), iAmAdmin = hasPerm(s, 'admin');
  const have = new Set(heldRoles(s, uid));
  const avail = Object.entries(s.roles || {}).filter(([id, r]) => id !== 'everyone' && (srvSuper(s) || (r.pos || 0) < mine) && (iAmAdmin || !(r.perms || []).includes('admin')))
    .sort((a, b) => (b[1].pos || 0) - (a[1].pos || 0));
  return h('div', {}, h('span', { class: 'set-lbl', text: 'Rollen van ' + n }),
    avail.length ? avail.map(([id, r]) => tgl(r.name, (r.perms || []).length + ' rechten', have.has(id), async (on) => {
      on ? have.add(id) : have.delete(id);
      const list = [...have, ...heldRoles(s, uid).filter(x => !avail.some(a => a[0] === x))];
      await upd(s, { [`mroles.${uid}`]: list.length ? [...new Set(list)] : deleteField() });
    })) : h('p', { class: 'hint', text: 'Er zijn geen rollen die jij mag toewijzen.' }));
}


/* =====================  online / inactief / offline  =====================
   - presence/{uid}          { state, lastSeen }   publiek leesbaar voor ingelogde gebruikers (per uid, niet opvraagbaar als lijst)
   - presenceSettings/{uid}  { mode, until }       alleen jijzelf (handmatige status, until = 0 betekent voor altijd)
   Schrijven gebeurt zuinig: alleen bij een echte statuswijziging (met minimale tussentijd) of als hartslag. */
const HEARTBEAT = 120000;   // elke 2 min een hartslag zolang je online/inactief bent
const MIN_GAP   = 20000;    // nooit vaker dan 1 write per 20 s (rules staan 15 s toe)
const STALE     = 270000;   // geen hartslag in 4,5 min -> bij anderen offline
const PEER_TTL  = 190000;   // andere tabbladen van jezelf (zelfde browser)
const LABEL = { online: 'Online', idle: 'Inactief', dnd: 'Niet storen', offline: 'Offline' };
const MODES = [
  ['auto', 'Online', 'Automatisch: online als je de site bekijkt, inactief op de achtergrond'],
  ['idle', 'Inactief', 'Je staat als inactief, ook als je de site bekijkt'],
  ['dnd', 'Niet storen', 'Anderen zien dat je even niet gestoord wilt worden'],
  ['invisible', 'Onzichtbaar', 'Je lijkt offline voor anderen']
];
const DURS = [[15, '15 minuten'], [60, '1 uur'], [480, '8 uur'], [1440, '24 uur'], [0, 'Voor altijd']];
const MODE_KEYS = new Set(MODES.map(m => m[0]));

const P = { data: {}, mob: {}, unsub: {} };   // presence van anderen: data = pc (presence/<uid>), mob = telefoon (presence/<uid>_m)
const NAME = {};                     // uid -> gebruikersnaam (voor de ledenlijst)
const pres = {
  on: false, id: '', settings: { mode: 'auto', until: 0 }, peers: new Map(),
  published: null, lastAt: 0, fails: 0, timer: 0, ping: 0, tick: 0, bc: null, unsubSet: null
};
let membersView = null, watchT = 0;

/* --- eigen handmatige status --- */
function activeManual() {
  const s = pres.settings;
  if (!s || !MODE_KEYS.has(s.mode) || s.mode === 'auto') return null;
  if (s.until && s.until <= Date.now()) return null;   // verlopen -> weer automatisch
  return s.mode;
}
const manualState = () => { const m = activeManual(); return m === 'invisible' ? 'offline' : m; };
const manualExpiry = () => (activeManual() && pres.settings.until) || 0;

/* --- weergave --- */
const RANK = { online: 0, dnd: 1, idle: 2, offline: 3 };
function docState(p) {
  if (!p || p.state === 'offline') return 'offline';
  const ls = p.lastSeen?.toMillis?.();
  if (ls && Date.now() - ls > STALE) return 'offline';
  return p.state;
}
function presState(uid) {
  if (uid === S.me?.uid) return manualState() || 'online';
  const a = docState(P.data[uid]), b = docState(P.mob[uid]);
  return RANK[b] < RANK[a] ? b : a;
}
// 'mobile' als de beste status van een telefoon komt (en niet van een pc)
function presDevice(uid) {
  if (uid === S.me?.uid) return IS_MOBILE ? 'mobile' : 'desktop';
  return RANK[docState(P.mob[uid])] < RANK[docState(P.data[uid])] ? 'mobile' : 'desktop';
}
function setDot(d) {
  const uid = d.dataset.uid, st = presState(uid);
  d.className = 'dot s-' + st;
  d.dataset.dev = st !== 'offline' && presDevice(uid) === 'mobile' ? 'mobile' : '';   // telefoon-icoontje i.p.v. bolletje
}
const sIcon = (st) => h('i', { class: 'sdot s-' + st });   // simpel gekleurd rondje
function pbadge(uid) { const st = presState(uid); return h('span', { class: 'pbadge s-' + st, 'data-uid': uid, text: LABEL[st] }); }
const ownLabel = () => activeManual() === 'invisible' ? 'Onzichtbaar' : LABEL[presState(S.me.uid)];
const PRES_CAP = 40;   // zoveel leden van één server volg je live (status); daarboven geen aantal online (scheelt veel Firestore-lezingen)
function srvMetaText(s) {
  const n = s.members.length, base = `${n} ${n === 1 ? 'lid' : 'leden'}`;
  return n > PRES_CAP ? base : `${base} · ${s.members.filter(u => presState(u) !== 'offline').length} online`;
}
function renderPresence() {
  if (!S.me) return;
  document.querySelectorAll('.dot[data-uid]').forEach(setDot);
  for (const sel of ['.pbadge', '.plabel']) {
    document.querySelectorAll(sel + '[data-uid]').forEach(el => {
      const st = presState(el.dataset.uid);
      el.className = sel.slice(1) + ' s-' + st; el.textContent = LABEL[st];
    });
  }
  const pill = $('#statusBtn');
  if (pill) {
    pill.replaceChildren(sIcon(presState(S.me.uid)), ownLabel());
    pill.title = statusSummary();
  }
  const c = S.chat;
  if (c?.type === 'dm') {
    const el = $('#peerStatus'), i = dmInfo(c.id);
    if (el && i) {
      const st = presState(i.uid);
      el.replaceChildren(sIcon(st), [LABEL[st], el.dataset.st].filter(Boolean).join(' · '));
    }
  } else if (c?.type === 'server') {
    const el = $('#srvMeta'), s = serverInfo(c.id);
    if (el && s) el.textContent = srvMetaText(s);
  }
  membersView?.render();
}

/* --- presence van anderen volgen: vrienden + de leden van de server die je nu open hebt --- */
function scheduleWatch() { clearTimeout(watchT); watchT = setTimeout(syncPresenceWatch, 0); }
function syncPresenceWatch() {
  if (!S.me) return;
  const want = new Set(accepted().map(otherId));
  if (S.chat?.type === 'server') {
    const sv = serverInfo(S.chat.id);
    if (sv) {
      // Elk gevolgd lid kost 3 luisteraars (+ een lezing bij elke hartslag). Kleine server: iedereen. Grote server: alleen wie je nu
      // ziet (schrijvers van de geladen berichten), aangevuld tot PRES_CAP.
      if (sv.members.length <= PRES_CAP) sv.members.forEach(u => want.add(u));
      else {
        const pick = new Set(Object.values(S.chat.byId || {}).map(m => m.uid).filter(u => sv.members.includes(u)));
        for (const u of sv.members) { if (pick.size >= PRES_CAP) break; pick.add(u); }
        [...pick].slice(0, PRES_CAP).forEach(u => want.add(u));
      }
    }
  }
  want.delete(S.me.uid);
  for (const u of Object.keys(P.unsub)) {
    if (!want.has(u)) { P.unsub[u](); delete P.unsub[u]; delete P.data[u]; delete P.mob[u]; }
  }
  for (const u of want) {
    if (P.unsub[u]) continue;
    const offP = onSnapshot(doc(db, 'presence', u),
      s => { P.data[u] = s.exists() ? s.data() : null; renderPresence(); }, () => {});
    const offM = onSnapshot(doc(db, 'presence', u + '_m'),
      s => { P.mob[u] = s.exists() ? s.data() : null; renderPresence(); }, () => {});
    const offU = onSnapshot(doc(db, 'users', u),
      s => { PROF[u] = s.exists() ? s.data() : null; onProfChange(u); }, () => {});
    P.unsub[u] = () => { offP(); offM(); offU(); };
  }
  renderPresence();
}

/* --- eigen status publiceren (alleen de "leider"-tab schrijft, zodat meerdere tabs elkaar niet tegenwerken) --- */
const isVisible = () => document.visibilityState === 'visible';
function announce() { pres.bc?.postMessage({ id: pres.id, vis: isVisible() }); }
function onPeer(e) {
  const m = e.data;
  if (!m?.id || m.id === pres.id) return;
  if (m.bye) pres.peers.delete(m.id);
  else {
    const isNew = !pres.peers.has(m.id);
    pres.peers.set(m.id, { vis: !!m.vis, t: Date.now() });
    if (isNew) announce();
  }
  reconcile();
}

async function writeState(state) {
  pres.published = state; pres.lastAt = Date.now();
  try {
    await setDoc(doc(db, 'presence', S.me.uid + (IS_MOBILE ? '_m' : '')), { state, lastSeen: serverTimestamp() });
    pres.fails = 0;
  } catch (e) {
    console.error(e);
    pres.published = null; pres.fails++;
    if (pres.fails === 3) toast(fbErr(e));
    reconcile();   // opnieuw proberen na de minimale tussentijd
  }
}

function reconcile() {
  clearTimeout(pres.timer);
  if (!pres.on || !S.me) return;
  const now = Date.now(), vis = isVisible();
  const live = [...pres.peers].filter(([, p]) => now - p.t < PEER_TTL);
  const anyVis = vis || live.some(([, p]) => p.vis);
  const pool = anyVis
    ? [...(vis ? [pres.id] : []), ...live.filter(([, p]) => p.vis).map(([id]) => id)]
    : [pres.id, ...live.map(([id]) => id)];
  if (pool.sort()[0] !== pres.id) {                      // een andere tab regelt het schrijven
    pres.published = null;
    pres.timer = setTimeout(reconcile, 60000);
    return;
  }
  const state = manualState() || (anyVis ? 'online' : 'idle');
  const gap = pres.fails >= 3 ? HEARTBEAT : MIN_GAP;
  let wait;
  if (state !== pres.published) wait = pres.lastAt + gap - now;              // echte wijziging
  else if (state === 'offline') wait = Infinity;                              // onzichtbaar: geen hartslag nodig
  else wait = pres.lastAt + HEARTBEAT - now;                                  // hartslag
  if (wait <= 0) { writeState(state); wait = state === 'offline' ? Infinity : HEARTBEAT; }
  const exp = manualExpiry();
  if (exp) wait = Math.min(wait, exp - now + 100);                            // handmatige status verloopt
  if (wait < Infinity) pres.timer = setTimeout(reconcile, Math.max(wait, 500));
}

const onVis = () => { announce(); reconcile(); renderPresence(); };
const onHide = () => pres.bc?.postMessage({ id: pres.id, bye: true });
const onShow = (e) => { if (e.persisted) { pres.published = null; announce(); reconcile(); } };

function startPresence() {
  if (pres.on || !S.me) return;
  Object.assign(pres, {
    on: true, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    settings: { mode: 'auto', until: 0 }, peers: new Map(), published: null, lastAt: 0, fails: 0
  });
  try { pres.bc = new BroadcastChannel('infinitum-presence-' + S.me.uid); pres.bc.onmessage = onPeer; }
  catch { pres.bc = null; }
  // pas schrijven nadat je instellingen binnen zijn (anders zou "onzichtbaar" even als online lekken)
  pres.unsubSet = onSnapshot(doc(db, 'presenceSettings', S.me.uid),
    s => { pres.settings = s.data() || { mode: 'auto', until: 0 }; renderPresence(); reconcile(); },
    () => reconcile());
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', onShow);
  announce();
  pres.ping = setInterval(announce, 60000);
  pres.tick = setInterval(renderPresence, 30000);        // verlopen hartslagen -> offline tonen
}

function stopPresence() {
  pres.on = false;
  clearTimeout(pres.timer); clearInterval(pres.ping); clearInterval(pres.tick);
  document.removeEventListener('visibilitychange', onVis);
  window.removeEventListener('pagehide', onHide);
  window.removeEventListener('pageshow', onShow);
  onHide();
  try { pres.bc?.close(); } catch {}
  pres.bc = null; pres.peers = new Map();
  pres.unsubSet?.(); pres.unsubSet = null;
  clearTimeout(watchT);
  for (const u of Object.keys(P.unsub)) { P.unsub[u](); delete P.unsub[u]; }
  P.data = {}; P.mob = {};
  for (const k of Object.keys(NAME)) delete NAME[k];
  membersView = null;
}

async function presenceGoOffline() {
  if (!pres.on || !S.me) return;
  const uid = S.me.uid;
  stopPresence();
  try { await setDoc(doc(db, 'presence', uid + (IS_MOBILE ? '_m' : '')), { state: 'offline', lastSeen: serverTimestamp() }); } catch {}
}

/* --- eigen status kiezen (klik op je avatar linksboven) --- */
function statusSummary() {
  const m = activeManual();
  if (!m) return 'Nu: automatisch (online als je de site bekijkt, inactief op de achtergrond).';
  const u = pres.settings.until, name = MODES.find(x => x[0] === m)[1];
  if (!u) return `Nu: ${name}, voor altijd.`;
  const d = new Date(u);
  return `Nu: ${name} tot ${dayKey(d) === dayKey(new Date()) ? '' : 'morgen '}${tf.format(d)}.`;
}

function openStatusPicker() {
  if (!S.me) return;
  let sel = activeManual() || 'auto';
  const list = h('div');
  const select = h('select', { class: 'inp' }, ...DURS.map(([m, t]) => h('option', { value: m, text: t })));
  select.value = '60';
  const durRow = h('label', { class: 'field' }, h('span', { text: 'Hoelang?' }), select);
  const err = h('p', { class: 'err' });
  const render = () => {
    list.replaceChildren(...MODES.map(([k, t, d]) => h('button', {
      class: 'item' + (sel === k ? ' active' : ''), type: 'button', onclick: () => { sel = k; render(); }
    },
      sIcon(k === 'auto' ? 'online' : k === 'invisible' ? 'offline' : k),
      h('span', { class: 'item-text' }, h('b', { text: t }), h('small', { text: d })))));
    durRow.hidden = sel === 'auto';
  };
  const go = async () => {
    const mins = +select.value;
    const until = sel === 'auto' || !mins ? 0 : Date.now() + mins * 60000;
    try { await setDoc(doc(db, 'presenceSettings', S.me.uid), { mode: sel, until }); closeDialog(); }
    catch (e) { err.textContent = fbErr(e); }
  };
  openDialog(
    h('h3', { text: 'Jouw status' }),
    h('p', { class: 'sub', text: statusSummary() }),
    list, durRow, err,
    h('div', { class: 'dlg-actions' },
      h('button', { class: 'ghost', type: 'button', onclick: closeDialog, text: 'Annuleren' }),
      h('button', { class: 'glow', type: 'button', onclick: go, text: 'Opslaan' })));
  render();
}

// status-knop onder je naam (linksboven)
const statusBtn = h('button', { class: 'status-pill', id: 'statusBtn', type: 'button', onclick: openStatusPicker });
$('#meName').after(statusBtn);

/* --- ledenlijst van de open server --- */
async function nameOf(uid) {
  if (PROF[uid]?.username) return PROF[uid].username;
  if (NAME[uid]) return NAME[uid];
  if (uid === S.me.uid) return S.profile?.username || 'Jij';
  const f = accepted().find(x => x.users.includes(uid));
  if (f?.names?.[uid]) return (NAME[uid] = f.names[uid]);
  try { const d = await getDoc(doc(db, 'users', uid)); return (NAME[uid] = d.data()?.username || 'Onbekend'); }
  catch { return 'Onbekend'; }
}

dlg.addEventListener('close', () => { membersView = null; plansView = null; ssView = null; });

/* =====================  instellingen, meldingen & profiel  =====================
   Instellingen (thema, achtergrond, meldingen, privacy) staan in Firestore: settings/{uid}, dus op al je apparaten hetzelfde.
   In localStorage staat alleen een kopie van thema + achtergrond, zodat de pagina niet even in het verkeerde thema flitst.
   Profielgegevens (foto, banner, bio, links) staan in users/{uid}. */
const SET_KEY = 'infinitum-settings';
// tier: 'free' = voor iedereen, 'plus' = Infinitum+ (en Prime), 'prime' = alleen Infinitum Prime
const BGS = [
  { id: 'cosmos',  name: 'Kosmos',        file: 'hero-background.svg', tier: 'free' },
  { id: 'aurora',  name: 'Aurora',        file: 'bg-aurora.svg',       tier: 'free' },
  { id: 'sunset',  name: 'Zonsondergang', file: 'bg-sunset.svg',       tier: 'free' },
  { id: 'ocean',   name: 'Oceaan',        file: 'bg-ocean.svg',        tier: 'free' },
  { id: 'nevel',   name: 'Nevel',         file: 'bg-nevel.svg',        tier: 'plus' },
  { id: 'neon',    name: 'Neon Stad',     file: 'bg-neon.svg',         tier: 'plus' },
  { id: 'bergen',  name: 'Bergen',        file: 'bg-bergen.svg',       tier: 'plus' },
  { id: 'kristal', name: 'Kristal',       file: 'bg-kristal.svg',      tier: 'plus' },
  { id: 'melkweg', name: 'Gouden Melkweg', file: 'bg-melkweg.svg',     tier: 'prime' }
];
const CUSTOM_BG = { id: 'custom', name: 'Eigen achtergrond', tier: 'plus' };   // eigen upload (Infinitum+), staat als afbeelding in settings/{uid}.customBg
const CUSTOM_KEY = 'infinitum-custombg';   // lokale kopie, zodat je eigen achtergrond direct zichtbaar is
const CUSTOM_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const CUSTOM_MAX = 260000;
const validCustom = (s) => typeof s === 'string' && s.length <= CUSTOM_MAX && CUSTOM_RE.test(s);
const TIER_RANK = { free: 0, plus: 1, prime: 2 };
const tierAtLeast = (t) => TIER_RANK[tierKey(S.profile)] >= TIER_RANK[t];
const bgInfo = (id) => BGS.find(b => b.id === id) || (id === 'custom' ? CUSTOM_BG : null);
// mag je deze achtergrond gebruiken? Zolang het profiel nog niet geladen is vertrouwen we de bewaarde keuze.
const bgAllowed = (id) => { const b = bgInfo(id); return !!b && (!S.profile || tierAtLeast(b.tier)); };
const DEF_CFG = { theme: 'dark', bg: 'cosmos', customBg: '', profileClick: true, privacy: { readReceipts: true }, notif: { desktop: false, sound: true, dm: true, server: true, mention: true, requests: true, preview: true } };
const cloneDef = () => JSON.parse(JSON.stringify(DEF_CFG));
// bouwt een geldige instellingen-set uit onbekende data (Firestore of de oude localStorage-versie)
function mergeCfg(r) {
  r = r && typeof r === 'object' ? r : {};
  const o = cloneDef();
  if (['dark', 'light', 'system'].includes(r.theme)) o.theme = r.theme;
  if (validCustom(r.customBg)) o.customBg = r.customBg;
  if (BGS.some(b => b.id === r.bg) || (r.bg === 'custom' && o.customBg)) o.bg = r.bg;
  if (typeof r.profileClick === 'boolean') o.profileClick = r.profileClick;
  if (typeof r.privacy?.readReceipts === 'boolean') o.privacy.readReceipts = r.privacy.readReceipts;
  for (const k of Object.keys(o.notif)) if (typeof r.notif?.[k] === 'boolean') o.notif[k] = r.notif[k];
  return o;
}
const CFG = (() => {
  try {
    const r = JSON.parse(localStorage.getItem(SET_KEY) || '{}');
    r.customBg = localStorage.getItem(CUSTOM_KEY) || '';
    return mergeCfg(r);
  } catch { return cloneDef(); }
})();
function resetPrivateCfg() { const d = cloneDef(); CFG.profileClick = d.profileClick; CFG.privacy = d.privacy; CFG.notif = d.notif; }

const cacheLook = () => {
  try { localStorage.setItem(SET_KEY, JSON.stringify({ theme: CFG.theme, bg: CFG.bg })); } catch {}
  try { CFG.customBg ? localStorage.setItem(CUSTOM_KEY, CFG.customBg) : localStorage.removeItem(CUSTOM_KEY); } catch {}
};
let setTimer = 0;
function saveSetNow() {
  clearTimeout(setTimer); setTimer = 0;
  if (S.profile && !bgAllowed(CFG.bg)) CFG.bg = 'cosmos';   // abonnement weg? Dan terug naar een gratis achtergrond
  cacheLook();
  if (!S.me) return;
  const data = {
    theme: CFG.theme, bg: CFG.bg, profileClick: CFG.profileClick,
    privacy: { readReceipts: CFG.privacy.readReceipts }, notif: { ...CFG.notif }
  };
  if (CFG.customBg && (!S.profile || tierAtLeast('plus'))) data.customBg = CFG.customBg;
  setDoc(doc(db, 'settings', S.me.uid), data).catch(e => toast(fbErr(e)));
}
// wijzigingen worden even gebundeld (bespaart schrijfacties op de gratis Firebase-versie)
const saveSet = () => { cacheLook(); clearTimeout(setTimer); setTimer = setTimeout(saveSetNow, 700); };

// klik op een profielfoto in de zijbalk opent het profiel (instelbaar bij Instellingen -> Profielen)
const rrOn = () => RR.enabled && CFG.privacy.readReceipts;
const applyProfileClick = () => { document.documentElement.dataset.pfclick = CFG.profileClick ? '1' : ''; };
applyProfileClick();

const lightMq = matchMedia('(prefers-color-scheme: light)');
function applyAppearance() {
  const r = document.documentElement;
  const theme = CFG.theme === 'system' ? (lightMq.matches ? 'light' : 'dark') : CFG.theme;
  r.dataset.theme = theme;
  let bg = bgAllowed(CFG.bg) && (CFG.bg !== 'custom' || CFG.customBg) ? CFG.bg : 'cosmos';
  if (bg === 'custom') r.style.setProperty('--bg-custom', `url("${CFG.customBg}")`); else r.style.removeProperty('--bg-custom');
  r.dataset.bg = bg;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'light' ? '#eef0ff' : '#050816');
}
lightMq.addEventListener?.('change', () => { if (CFG.theme === 'system') applyAppearance(); });

$('#settingsBtn').innerHTML = I.gear;
$('#settingsBtn').addEventListener('click', () => {
  // in de instellingen? Dan terug naar waar je was (tabblad + open gesprek blijven bewaard)
  if (S.tab === 'settings') setTab(S.prevTab && S.prevTab !== 'settings' ? S.prevTab : 'dms');
  else { S.prevTab = S.tab; setTab('settings'); }
});

/* --- meldingen --- */
let audioCtx;
function beep() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [[880, 0], [1175, .11]].forEach(([f, d]) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + d);
      g.gain.linearRampToValueAtTime(.12, t + d + .01);
      g.gain.exponentialRampToValueAtTime(.001, t + d + .22);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + d); o.stop(t + d + .25);
    });
  } catch {}
}
const canDesktop = () => 'Notification' in window && Notification.permission === 'granted';

// kind: 'dm' | 'server' | 'requests'. Bij "Niet storen" komt er niets binnen.
function notify(kind, title, body, go, open = '') {
  if (!CFG.notif[kind] || manualState() === 'dnd') return;
  if (CFG.notif.sound) beep();
  const text = CFG.notif.preview ? body : 'Nieuw bericht';
  if (isVisible() && document.hasFocus()) { toast(`${title}: ${text}`); return; }
  if (CFG.notif.desktop && canDesktop() && !localStorage.getItem('infinitum-push')) {
    const opts = { body: text, icon: 'assets/icons/icon-192.png', badge: 'assets/icons/badge-96.png', tag: 'infinitum-' + kind, data: { open } };
    (async () => {
      try { const reg = await navigator.serviceWorker?.ready; if (reg?.showNotification) { await reg.showNotification(title, opts); return; } } catch {}
      try { const n = new Notification(title, opts); n.onclick = () => { window.focus(); go?.(); n.close(); }; } catch {}
    })();
  }
}
function checkNewRequests() {
  if (!S.me) return;
  const inc = incoming();
  if (S.reqSeen) {
    for (const f of inc) if (!S.reqSeen.has(f.id)) notify('requests', otherName(f), 'wil vrienden worden', () => setTab('requests'), 'requests');
  }
  S.reqSeen = new Set(inc.map(f => f.id));
}
async function showSwNotification(title, body, open = '', tag = 'infinitum-test') {
  const reg = await navigator.serviceWorker?.ready;
  if (!reg?.showNotification) throw new Error('Geen service worker');
  await reg.showNotification(title, { body, icon: 'assets/icons/icon-192.png', badge: 'assets/icons/badge-96.png', tag, data: { open } });
}
async function testNotify() {
  if (CFG.notif.sound) beep();
  if (!canDesktop()) { toast('Zo zien je meldingen eruit. (Zet bureaubladmeldingen of pushmeldingen aan om ook echte meldingen te krijgen.)'); return; }
  try { await showSwNotification(myTier().name, 'Zo zien je meldingen eruit.'); }
  catch (e) { console.warn(e); try { new Notification(myTier().name, { body: 'Zo zien je meldingen eruit.', icon: myTier().icon }); } catch { toast('Melding tonen mislukt.'); } }
}
const permText = () => !('Notification' in window) ? 'Je browser ondersteunt geen bureaubladmeldingen.'
  : Notification.permission === 'denied' ? 'Meldingen zijn geblokkeerd in je browser. Sta ze toe via het slotje naast de adresbalk.'
  : Notification.permission === 'granted' ? 'De browser geeft toestemming voor bureaubladmeldingen.'
  : 'De browser vraagt toestemming zodra je bureaubladmeldingen aanzet.';

/* --- webapp installeren + pushmeldingen (ook als de app dicht is of je telefoon op slot zit) ---
   Per toestel: een FCM-token in Firestore -> pushTokens/<token> { uid, ua, updatedAt }. De Cloud Function (map functions/)
   stuurt daar een bericht naartoe bij een nieuw bericht, vriendschapsverzoek of melding. */

// Vraagt de push-dienst (Cloudflare Worker) een melding te sturen. Mislukt dit, dan merkt de gebruiker er niets van.
async function pushPing(payload) {
  if (!PUSH_URL || !auth.currentUser) return null;
  try {
    const idt = await auth.currentUser.getIdToken();
    const r = await fetch(PUSH_URL.replace(/\/$/, '') + '/notify', {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idt },
      body: JSON.stringify(payload)
    });
    return await r.json().catch(() => null);
  } catch (e) { console.warn('Pushmelding aanvragen mislukt:', e); return null; }
}
const PUSH_FLAG = 'infinitum-push';
const PUSH = { token: '', busy: false };
const pushReady = () => !!VAPID_KEY;

async function pushRegister() {
  const reg = await navigator.serviceWorker.ready;
  const token = await getToken(getMessaging(fbApp), { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
  if (!token) throw new Error('Geen pushtoken ontvangen.');
  await setDoc(doc(db, 'pushTokens', token), { uid: S.me.uid, ua: navigator.userAgent.slice(0, 120), updatedAt: serverTimestamp() });
  PUSH.token = token;
  try { localStorage.setItem(PUSH_FLAG, token); } catch {}
  return token;
}
async function pushEnable() {
  if (!pushReady()) throw new Error('Pushmeldingen zijn nog niet ingesteld (VAPID-sleutel ontbreekt in js/firebase.js).');
  if (!(await pushSupported())) throw new Error(isIOS() && !isStandalone()
    ? 'Op iPhone/iPad werken pushmeldingen alleen als je Infinitum eerst op je beginscherm zet (Deel → Zet op beginscherm).'
    : 'Deze browser ondersteunt geen pushmeldingen.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Toestemming geweigerd. Sta meldingen toe in de instellingen van je browser of telefoon.');
  await pushRegister();
  CFG.notif.desktop = true; saveSet();
}
async function pushDisable() {
  const token = PUSH.token || localStorage.getItem(PUSH_FLAG) || '';
  try { if (token) await deleteDoc(doc(db, 'pushTokens', token)); } catch {}
  try { await deleteToken(getMessaging(fbApp)); } catch {}
  PUSH.token = ''; try { localStorage.removeItem(PUSH_FLAG); } catch {}
}
// bij uitloggen: dit toestel koppelt los van dit account (token blijft bestaan voor de volgende login)
async function pushDetach() {
  const token = PUSH.token || localStorage.getItem(PUSH_FLAG) || '';
  if (!token || !S.me) return;
  try { await deleteDoc(doc(db, 'pushTokens', token)); } catch {}
}
// bij elke start: token vernieuwen en aan het huidige account koppelen
async function pushRefresh() {
  try {
    if (!pushReady() || !localStorage.getItem(PUSH_FLAG) || !('Notification' in window) || Notification.permission !== 'granted') return;
    if (!(await pushSupported())) return;
    await pushRegister();
  } catch (e) { console.warn('Push vernieuwen mislukt:', e); }
}

// naar een gesprek e.d. springen vanuit een melding ("dm:<id>", "server:<id>", "inbox", "requests", "admin")
let pendingOpen = (() => {
  try { const q = new URLSearchParams(location.search).get('open'); if (q) { history.replaceState(null, '', location.pathname); return q; } } catch {}
  return '';
})();
function applyOpen(target = pendingOpen, tries = 0) {
  if (!target || !S.me) return;
  pendingOpen = '';
  const [kind, id, cid] = String(target).split(':');
  if (kind === 'dm' || kind === 'server') {
    const ready = kind === 'dm' ? !!dmInfo(id) : !!serverInfo(id);
    if (!ready) { if (tries < 12) setTimeout(() => applyOpen(target, tries + 1), 400); return; }
    if (kind === 'dm') S.activeDm = id; else { S.activeServer = id; S.activeChannel = cid || null; }
    S.tab = kind === 'dm' ? 'dms' : 'servers'; renderTabs(); renderSidebar(true); showMain();
  } else if (kind === 'inbox') { goPage('inbox'); setView('main'); }
  else if (kind === 'requests') setTab('requests');
  else if (kind === 'admin') { goPage('admin', 'requests'); setView('main'); }
}
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.type === 'open') { pendingOpen = e.data.open || ''; applyOpen(); } });

function appItem(item) {
  const box = h('div', { class: 'app-card' });
  const tx = h('div', { class: 'tog-text' });
  const ios = isIOS();
  if (isStandalone()) {
    tx.append(h('b', { text: 'Infinitum is geïnstalleerd' }), h('small', { text: 'Je gebruikt Infinitum als app op dit toestel.' }));
    box.append(tx);
  } else if (INST.ev) {
    tx.append(h('b', { text: 'Installeer Infinitum als app' }), h('small', { text: 'Eigen icoon op je beginscherm, schermvullend en met pushmeldingen.' }));
    box.append(tx, h('button', { class: 'glow sm', type: 'button', text: 'Installeren', onclick: async () => {
      const ev = INST.ev; if (!ev) return;
      ev.prompt(); try { await ev.userChoice; } catch {}
      INST.ev = null; renderSettings();
    } }));
  } else {
    tx.append(h('b', { text: 'Installeer Infinitum als app' }), h('small', { text: 'Eigen icoon op je beginscherm, schermvullend en met pushmeldingen.' }),
      h('ol', { class: 'app-steps' },
        ios
          ? [h('li', {}, 'Open deze site in ', h('b', { text: 'Safari' }), '.'), h('li', {}, 'Tik op ', h('b', { text: 'Deel' }), ' (vierkantje met pijl).'), h('li', {}, 'Kies ', h('b', { text: 'Zet op beginscherm' }), ' en tik op Voeg toe.')]
          : [h('li', {}, 'Open het menu van je browser (', h('b', { text: '⋮' }), ').'), h('li', {}, 'Kies ', h('b', { text: 'App installeren' }), ' of ', h('b', { text: 'Toevoegen aan startscherm' }), '.')]));
    box.append(tx);
  }
  return item('app installeren beginscherm download telefoon', true, box);
}

function pushItem(item, permNote) {
  const cb = h('input', { type: 'checkbox' });
  const small = h('small', { text: 'Krijg een melding bij nieuwe berichten, ook als Infinitum dicht is of je scherm op slot zit. Geldt alleen voor dit toestel.' });
  const note = h('p', { class: 'perm-note' });
  const on = !!localStorage.getItem(PUSH_FLAG) && 'Notification' in window && Notification.permission === 'granted';
  cb.checked = on;
  if (!pushReady()) note.textContent = 'Nog niet ingesteld: de beheerder moet eerst de VAPID-sleutel in js/firebase.js plakken (zie README).';
  else if (isIOS() && !isStandalone()) note.textContent = 'Op iPhone/iPad werken pushmeldingen alleen nadat je Infinitum op je beginscherm hebt gezet (zie hierboven).';
  cb.addEventListener('change', async () => {
    if (PUSH.busy) { cb.checked = !cb.checked; return; }
    PUSH.busy = true; cb.disabled = true; note.textContent = '';
    try {
      if (cb.checked) { await pushEnable(); note.textContent = 'Pushmeldingen staan aan op dit toestel.'; }
      else { await pushDisable(); note.textContent = 'Pushmeldingen staan uit op dit toestel.'; }
    } catch (e) { cb.checked = !cb.checked; note.textContent = e?.message || 'Er ging iets mis.'; }
    finally { PUSH.busy = false; cb.disabled = false; }
  });
  const row = h('label', { class: 'tog' }, h('span', { class: 'tog-text' }, h('b', { text: 'Pushmeldingen op dit toestel' }), small), cb, h('i'));
  const test = h('button', { class: 'ghost sm', type: 'button', text: 'Testpush via de server sturen', onclick: async () => {
    if (!PUSH.token && !localStorage.getItem(PUSH_FLAG)) { note.textContent = 'Zet eerst pushmeldingen aan.'; return; }
    if (!PUSH_URL) { note.textContent = 'De pushserver is nog niet ingesteld: de beheerder moet PUSH_URL in js/firebase.js invullen.'; return; }
    note.textContent = 'Bezig…';
    const r = await pushPing({ type: 'test' });
    if (!r) note.textContent = 'Geen antwoord van de pushserver. Controleer PUSH_URL en of de Worker draait.';
    else if (!r.ok) note.textContent = 'Niet verstuurd: ' + (r.reason || 'onbekende reden');
    else note.textContent = `Testpush onderweg naar ${r.tokens} toestel${r.tokens === 1 ? '' : 'len'}: je krijgt hem binnen een paar seconden. Sluit de app of vergrendel je scherm voor de echte test.`;
  } });
  return item('push meldingen notificaties telefoon achtergrond app test', false, row, note, test);
}

/* --- achtergronden: popup met meer, upgrade-vraag en eigen upload --- */
function askUpgrade(tier, what) {
  const t = TIERS[tier];
  openDialog(
    h('h3', { text: `${t.name} nodig` }),
    h('p', { class: 'sub', text: `${what} is er voor leden met ${t.name}. Bekijk de abonnementen of vraag gratis een upgrade aan.` }),
    h('div', { class: 'dlg-actions' },
      h('button', { class: 'ghost', type: 'button', onclick: closeDialog, text: 'Sluiten' }),
      h('button', { class: 'glow', type: 'button', onclick: () => openPlans(), text: 'Bekijk abonnementen' })));
}

async function pickCustomBg(after) {
  if (!tierAtLeast('plus')) { askUpgrade('plus', 'Een eigen achtergrond uploaden'); return; }
  const file = await pickFile();
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Kies een afbeelding (jpg, png, webp of gif).'); return; }
  const s = await openCropper(file, 1280, 720, { maxLen: 240000, title: 'Achtergrond bijsnijden' });
  if (!s) return;
  CFG.customBg = s; CFG.bg = 'custom';
  saveSet(); applyAppearance(); after?.();
  toast('Je eigen achtergrond staat aan.');
}

function openBgPicker(after) {
  const tiles = [];
  const paint = () => tiles.forEach(([b, el]) => el.classList.toggle('active', CFG.bg === b.id));
  const tile = (b) => {
    const ok = tierAtLeast(b.tier);
    const el = h('button', {
      class: 'bg-opt bgp-tile' + (b.tier === 'prime' ? ' prime' : '') + (ok ? '' : ' locked'),
      type: 'button', title: b.name, 'aria-label': b.name + (ok ? '' : ' (vergrendeld)'),
      onclick: () => {
        if (!bgAllowed(b.id)) { askUpgrade(b.tier, `De achtergrond "${b.name}"`); return; }
        CFG.bg = b.id; saveSet(); applyAppearance(); paint(); after?.();
      }
    },
      h('span', { class: 'bg-thumb', style: `background-image:url(assets/${b.file})` }, ok ? null : h('span', { class: 'bg-lock', html: I.lock })),
      h('span', { class: 'bg-name' }, b.name));
    tiles.push([b, el]);
    return el;
  };
  const group = (tier, text, list, cls = '') => h('section', { class: 'bgp-group' },
    h('p', { class: 'bgp-head' }, h('img', { src: TIERS[tier].icon, alt: '' }), h('span', { text }),
      tierAtLeast(tier) ? null : h('span', { class: 'tier-chip', text: 'Vergrendeld' })),
    h('div', { class: 'bg-grid bgp-grid ' + cls }, list.map(tile)));
  openDialog(
    h('h3', { text: 'Meer achtergronden' }),
    h('p', { class: 'sub', text: 'Kies een ingebouwde achtergrond. Vergrendelde achtergronden horen bij een abonnement.' }),
    group('plus', 'Infinitum+', BGS.filter(b => b.tier === 'plus')),
    group('prime', 'Infinitum Prime', BGS.filter(b => b.tier === 'prime'), 'one'),
    h('div', { class: 'dlg-actions' }, h('button', { class: 'ghost', type: 'button', onclick: closeDialog, text: 'Sluiten' })));
  dlg.classList.add('wide', 'bgs');
  paint();
}

/* --- instellingenpagina --- */
function renderSettings() {
  const THEMES = [['dark', 'Donker', I.moon], ['light', 'Licht', I.sun], ['system', 'Systeem', I.monitor]];
  const mark = () => {
    themeBtns.forEach((el, i) => el.classList.toggle('active', THEMES[i][0] === CFG.theme));
    paintBgs();
  };
  const themeBtns = THEMES.map(([k, t, ic]) => h('button', {
    class: 'opt', type: 'button',
    onclick: () => { CFG.theme = k; saveSet(); applyAppearance(); mark(); }
  }, h('span', { class: 'opt-ic', html: ic }), t));

  // de gratis achtergronden (+ je eigen upload, als je die hebt), met daaronder "meer" en "uploaden"
  const bgGrid = h('div', { class: 'bg-grid' });
  const bgActs = h('div', { class: 'bg-acts' });
  const bgNote = h('p', { class: 'hint bg-note' });
  const pick = (id) => { CFG.bg = id; saveSet(); applyAppearance(); mark(); };
  function paintBgs() {
    const list = BGS.filter(b => b.tier === 'free');
    if (CFG.customBg) list.push(CUSTOM_BG);
    bgGrid.replaceChildren(...list.map(b => h('button', {
      class: 'bg-opt' + (CFG.bg === b.id ? ' active' : ''), type: 'button', title: b.name,
      onclick: () => (bgAllowed(b.id) ? pick(b.id) : askUpgrade(b.tier, 'Je eigen achtergrond'))
    }, h('span', { class: 'bg-thumb', style: b.id === 'custom' ? `background-image:url("${CFG.customBg}")` : `background-image:url(assets/${b.file})` }),
       h('span', { class: 'bg-name', text: b.name }))));
    const cur = bgInfo(CFG.bg);
    bgNote.hidden = !cur || cur.tier === 'free' || cur.id === 'custom';
    if (!bgNote.hidden) bgNote.textContent = `Gekozen: ${cur.name} (${TIERS[cur.tier].name})`;
    bgActs.replaceChildren(
      h('button', { class: 'ghost sm bg-act', type: 'button', onclick: () => openBgPicker(mark) },
        h('span', { class: 'ic', html: I.palette }), 'Meer achtergronden'),
      h('button', { class: 'ghost sm bg-act', type: 'button', onclick: () => pickCustomBg(mark) },
        h('span', { class: 'ic', html: I.upload }), 'Eigen achtergrond uploaden',
        h('span', { class: 'tier-chip', text: 'Plus' })),
      CFG.customBg ? h('button', { class: 'ghost sm bg-act', type: 'button', onclick: () => {
        CFG.customBg = ''; if (CFG.bg === 'custom') CFG.bg = 'cosmos';
        saveSet(); applyAppearance(); mark();
      } }, h('span', { class: 'ic', html: I.trash }), 'Eigen achtergrond verwijderen') : null);
  }
  paintBgs();

  const permNote = h('p', { class: 'perm-note', text: permText() });
  const tog = (key, title, desc, onChange) => {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = !!CFG.notif[key];
    cb.addEventListener('change', async () => {
      if (onChange && !(await onChange(cb.checked))) { cb.checked = !cb.checked; return; }
      CFG.notif[key] = cb.checked; saveSet();
    });
    return h('label', { class: 'tog' }, h('span', { class: 'tog-text' }, h('b', { text: title }), h('small', { text: desc })), cb, h('i'));
  };
  const askDesktop = async (on) => {
    if (!on) return true;
    if (!('Notification' in window)) { permNote.textContent = permText(); return false; }
    let p = Notification.permission;
    if (p === 'default') { try { p = await Notification.requestPermission(); } catch {} }
    permNote.textContent = permText();
    return p === 'granted';
  };

  const profTog = (() => {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = !!CFG.profileClick;
    cb.addEventListener('change', () => { CFG.profileClick = cb.checked; saveSet(); applyProfileClick(); });
    return h('label', { class: 'tog' },
      h('span', { class: 'tog-text' },
        h('b', { text: 'Profiel openen via de zijbalk' }),
        h('small', { text: 'Klik op de profielfoto van een vriend in de lijst links om meteen zijn of haar profiel te openen. Uit = de foto opent gewoon het gesprek.' })),
      cb, h('i'));
  })();

  const rrTog = (() => {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = !!CFG.privacy.readReceipts;
    cb.addEventListener('change', () => { CFG.privacy.readReceipts = cb.checked; saveSet(); syncReadWatch(); });
    return h('label', { class: 'tog' },
      h('span', { class: 'tog-text' },
        h('b', { text: 'Leesbewijzen' }),
        h('small', { text: 'Laat anderen met een oogje zien dat je hun bericht hebt gelezen. Uit = jij ziet ook niet wie jouw berichten leest.' })),
      cb, h('i'));
  })();

  // elk zoekbaar blokje is een .set-item; elke categorie een .set-sec (zie filterSettings)
  const item = (keys, wide, ...kids) => {
    const el = h('div', { class: 'set-item' + (wide ? ' wide' : '') }, ...kids);
    el.dataset.q = (keys + ' ' + el.textContent).toLowerCase();
    return el;
  };
  const sec = (id, title, ...items) => {
    const el = h('section', { class: 'set-card set-sec', id: 'set-' + id, 'data-sec': id }, h('h3', { text: title }), h('div', { class: 'set-items' }, ...items));
    el.dataset.q = title.toLowerCase();
    return el;
  };
  const dnd = h('div', {}, permNote,
    h('button', { class: 'ghost sm', type: 'button', onclick: testNotify, text: 'Testmelding sturen' }),
    h('p', { class: 'perm-note', text: 'Staat je status op "Niet storen", dan krijg je geen meldingen.' }));

  const keep = document.querySelector('.pane.settings')?.scrollTop || 0;
  const empty = h('p', { class: 'hint', id: 'setEmpty', text: 'Niets gevonden. Probeer een ander woord.' });
  empty.hidden = true;
  const pane = h('div', { class: 'pane settings' },
    h('div', { class: 'set-head' },
      h('button', { class: 'icon-btn back', type: 'button', html: I.back, 'aria-label': 'Terug', onclick: () => setView('list') }),
      h('div', {},
        h('h2', { text: 'Instellingen' }),
        h('p', { class: 'sub', text: 'Deze instellingen worden bij je account bewaard en gelden op al je apparaten.' }))),
    empty,
    sec('weergave', 'Weergave',
      item('thema donker licht systeem uiterlijk', true, h('p', { class: 'set-lbl', text: 'Thema' }), h('div', { class: 'opts' }, themeBtns)),
      item('achtergrond eigen upload plus prime meer ' + BGS.map(b => b.name).join(' '), true, h('p', { class: 'set-lbl', text: 'Achtergrond' }), bgGrid, bgNote, bgActs)),
    sec('profielen', 'Profielen',
      item('profiel foto zijbalk', false, profTog),
      item('profiel foto banner bio links tip', false, h('p', { class: 'hint', text: 'Tip: klik op je profielfoto linksboven om je foto, banner, bio en links aan te passen.' }))),
    sec('privacy', 'Privacy',
      item('privacy leesbewijzen oogje gelezen', false, rrTog)),
    sec('meldingen', 'Meldingen',
      item('', false, tog('desktop', 'Bureaubladmeldingen', 'Een melding van je browser als de site op de achtergrond staat.', askDesktop)),
      item('', false, tog('dm', 'Directe berichten', 'Een melding bij een nieuw bericht van een vriend.')),
      item('', false, tog('server', 'Servers', 'Een melding bij nieuwe berichten in (niet-officiële) servers.')),
      item('', false, tog('mention', 'Vermeldingen', 'Een melding als iemand jou, een rol van jou of @everyone tagt.')),
      item('', false, tog('requests', 'Verzoeken', 'Een melding bij een vriendschapsverzoek, een abonnementsaanvraag (moderators) en als jouw aanvraag is beoordeeld.')),
      item('', false, tog('sound', 'Geluid', 'Een kort geluidje bij elke melding.')),
      item('', false, tog('preview', 'Berichttekst tonen', 'Uit = je ziet alleen dat er een bericht is, niet wat erin staat.')),
      item('testmelding toestemming niet storen', true, dnd)),
    sec('app', 'App & pushmeldingen', appItem(item), pushItem(item, permNote)),
    sec('credits', 'Credits',
      Object.assign(item('credits moderators admins team beheer', true,
        h('p', { class: 'sub', text: 'Deze moderators houden Infinitum in goede banen: ze beoordelen abonnementsaanvragen en beheren de community.' }),
        h('div', { class: 'credit-list', id: 'creditsList' })), {})));
  $('#main').replaceChildren(pane);
  pane.addEventListener('scroll', () => {
    const secs = [...pane.querySelectorAll('.set-sec:not([hidden])')];
    if (!secs.length) return;
    const top = pane.getBoundingClientRect().top;
    let cur = secs[0].dataset.sec;
    for (const x of secs) if (x.getBoundingClientRect().top - top <= 70) cur = x.dataset.sec;
    if (pane.scrollHeight - pane.scrollTop - pane.clientHeight < 4) cur = secs[secs.length - 1].dataset.sec;
    if (cur !== SET_UI.active) { SET_UI.active = cur; markNav(); }
  }, { passive: true });
  pane.scrollTop = keep;
  mark(); paintCredits(); filterSettings(); markNav();
}

/* --- instellingen: zijbalk (categorieën + zoeken + credits) --- */
const SET_SECS = [
  { id: 'weergave', title: 'Weergave', ic: I.palette, d: 'Thema en achtergrond' },
  { id: 'profielen', title: 'Profielen', ic: I.user, d: 'Profielfoto in de zijbalk' },
  { id: 'privacy', title: 'Privacy', ic: I.lock, d: 'Leesbewijzen' },
  { id: 'meldingen', title: 'Meldingen', ic: I.bell, d: 'Geluid, bureaublad en servers' },
  { id: 'app', title: 'App', ic: I.phone, d: 'Installeren en pushmeldingen' }
];
const SET_UI = { q: '', active: 'weergave' };

function markNav() {
  document.querySelectorAll('.set-nav, .set-credits').forEach(b => b.classList.toggle('active', b.dataset.sec === SET_UI.active));
}

// zoeken: toont alleen de blokjes die passen; een categorie waarvan de titel past blijft helemaal zichtbaar
function filterSettings() {
  const pane = document.querySelector('.pane.settings');
  if (!pane) return;
  const q = SET_UI.q.trim().toLowerCase();
  const hit = {};
  let any = false;
  pane.querySelectorAll('.set-sec').forEach(x => {
    const titleHit = !q || x.dataset.q.includes(q);
    let shown = 0;
    x.querySelectorAll('.set-item').forEach(it => { const ok = titleHit || it.dataset.q.includes(q); it.hidden = !ok; if (ok) shown++; });
    x.hidden = !shown;
    hit[x.dataset.sec] = shown > 0;
    if (shown) any = true;
  });
  const em = $('#setEmpty'); if (em) em.hidden = any;
  document.querySelectorAll('.set-nav, .set-credits').forEach(b => b.classList.toggle('dim', !hit[b.dataset.sec]));
}

function goSection(id) {
  const pane0 = document.querySelector('.pane.settings');
  if (!pane0) renderSettings();
  setView('main');
  const pane = document.querySelector('.pane.settings'), x = document.getElementById('set-' + id);
  if (!pane || !x) return;
  if (x.hidden) {   // zit weggefilterd door de zoekbalk: zoekopdracht wissen
    SET_UI.q = ''; const inp = document.querySelector('.set-search'); if (inp) inp.value = '';
    filterSettings();
  }
  SET_UI.active = id; markNav();
  pane.scrollTo({ top: pane.scrollTop + x.getBoundingClientRect().top - pane.getBoundingClientRect().top - 12, behavior: 'smooth' });
}

function buildSettingsNav(list, foot) {
  const search = h('input', { class: 'inp set-search', type: 'search', placeholder: 'Zoeken in instellingen…', autocomplete: 'off', 'aria-label': 'Zoeken in instellingen' });
  search.value = SET_UI.q;
  search.addEventListener('input', () => { SET_UI.q = search.value; filterSettings(); });
  list.replaceChildren(search, ...SET_SECS.map(c => h('button', { class: 'item set-nav', type: 'button', 'data-sec': c.id, onclick: () => goSection(c.id) },
    h('span', { class: 'set-ic', html: c.ic }),
    h('span', { class: 'item-text' }, h('b', { text: c.title }), h('small', { text: c.d })))));
  foot.replaceChildren(h('button', { class: 'ghost set-credits', type: 'button', 'data-sec': 'credits', text: 'Credits', onclick: () => goSection('credits') }));
  markNav();
}

// credits: de moderators (= admins), live uit de badges
const creditUids = () => [...new Set(BADGES.filter(b => b.id === 'moderator' || b.id === 'admin').flatMap(b => Array.isArray(b.users) ? b.users : []))];
function paintCredits() {
  const box = $('#creditsList');
  if (!box || !S.me) return;
  const ids = creditUids();
  loadProfiles(ids.filter(u => u !== S.me.uid));
  if (!ids.length) { box.replaceChildren(h('p', { class: 'hint', text: 'Er zijn nog geen moderators ingesteld.' })); return; }
  box.replaceChildren(...ids.map(u => {
    const p = u === S.me.uid ? S.profile : PROF[u];
    const name = p?.username || '…';
    return h('div', { class: 'credit' }, avatar(u, name, 44, true),
      h('span', { class: 'item-text' }, h('b', { text: name }), h('small', { text: 'Moderator' })));
  }));
}

/* --- links als knop (link-icoon + favicon + naam) --- */
const BRAND = {
  youtube: 'YouTube', youtu: 'YouTube', github: 'GitHub', instagram: 'Instagram', tiktok: 'TikTok', twitter: 'X', x: 'X',
  twitch: 'Twitch', discord: 'Discord', spotify: 'Spotify', linkedin: 'LinkedIn', reddit: 'Reddit', facebook: 'Facebook',
  steam: 'Steam', steampowered: 'Steam', soundcloud: 'SoundCloud', pinterest: 'Pinterest', snapchat: 'Snapchat',
  telegram: 'Telegram', whatsapp: 'WhatsApp', paypal: 'PayPal', patreon: 'Patreon', kick: 'Kick', roblox: 'Roblox',
  bsky: 'Bluesky', bluesky: 'Bluesky'
};
function parseLink(raw) {
  let s = String(raw || '').trim();
  if (!s || /\s/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u; try { u = new URL(s); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const parts = host.split('.');
  let base = parts[parts.length - 2];
  if (parts.length > 2 && parts[parts.length - 1].length === 2 && ['co', 'com', 'org', 'net', 'gov', 'ac'].includes(base)) base = parts[parts.length - 3];
  const name = BRAND[base] || (base[0].toUpperCase() + base.slice(1));
  return { href: u.href, host, name };
}
function linkChip(l, onRemove) {
  const info = parseLink(l);   // altijd opnieuw controleren: alleen http(s)-links worden ooit een <a>
  if (!info) return null;
  const inner = [
    h('span', { class: 'lk', html: I.link }),
    h('img', {
      class: 'fav', alt: '', loading: 'lazy', referrerpolicy: 'no-referrer',
      onerror: e => e.target.remove(),
      src: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(info.host)}&sz=64`
    }),
    h('span', { text: info.name })
  ];
  if (!onRemove) return h('a', { class: 'linkbtn', href: info.href, target: '_blank', rel: 'noopener noreferrer nofollow', title: info.href }, ...inner);
  // in de profiel-editor: de link zelf is klikbaar (opent in een nieuw tabblad), het kruisje verwijdert hem
  return h('span', { class: 'linkbtn editable' },
    h('a', { class: 'lb-open', href: info.href, target: '_blank', rel: 'noopener noreferrer nofollow', title: 'Openen: ' + info.href }, ...inner),
    h('button', { class: 'lk-x', type: 'button', html: I.x, 'aria-label': 'Link verwijderen', onclick: onRemove }));
}

/* --- reageren op profielwijzigingen van anderen (naam/foto) --- */
function onProfChange(u) {
  refreshAvatars(); scheduleSidebar();
  if (S.tab === 'settings') paintCredits();
  if (S.tab === 'friends') renderFriendList();
  if (S.chat?.type === 'dm' && dmInfo(S.chat.id)?.uid === u) {
    const old = $('#chatHead');
    if (old) { old.replaceWith(buildHead('dm', S.chat.id)); renderPresence(); }
  }
}

/* --- afbeeldingen: kiezen, slepen-en-neerzetten, bijsnijden (slepen + zoomen) --- */
const imgBg = (src, id) => {
  const b = safeBanner(src);
  if (HEX_RE.test(b)) return b;
  return b ? `center / cover no-repeat url("${b}")` : gradFor(id);
};
function paintBig(el, src, id, name) {
  const s = safeImg(src);
  el.style.background = s ? `center / cover no-repeat url("${s}")` : gradFor(id);
  el.textContent = s ? '' : letterOf(name);
}
function pickFile() {
  return new Promise(res => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = () => res(inp.files[0] || null);
    inp.addEventListener('cancel', () => res(null));
    inp.click();
  });
}
function dropTarget(el, onFile) {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  el.addEventListener('dragover', e => { stop(e); el.classList.add('drop'); });
  el.addEventListener('dragleave', e => { stop(e); el.classList.remove('drop'); });
  el.addEventListener('drop', e => {
    stop(e); el.classList.remove('drop');
    const f = [...(e.dataTransfer?.files || [])].find(x => x.type.startsWith('image/'));
    if (f) onFile(f); else toast('Sleep een afbeelding (jpg, png, webp of gif).');
  });
}

// Toont de afbeelding in een vak ter grootte van het resultaat: sleep om te verplaatsen, zoom met schuifbalk of muiswiel.
async function openCropper(file, outW, outH, { round = false, maxLen = 140000, title = '' } = {}) {
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { toast('Die afbeelding kon niet worden geladen.'); return null; }

  return new Promise(resolve => {
    const VW = Math.max(160, Math.min(round ? 280 : 460, window.innerWidth - 100));
    const VH = Math.round(VW * outH / outW);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cv = h('canvas', { class: 'crop-cv' + (round ? ' round' : '') });
    cv.width = VW * dpr; cv.height = VH * dpr; cv.style.width = VW + 'px'; cv.style.height = VH + 'px';
    const ctx = cv.getContext('2d');

    const base = Math.max(VW / bmp.width, VH / bmp.height);   // minimale schaal: de afbeelding vult het vak
    let zoom = 1, ox = (VW - bmp.width * base) / 2, oy = (VH - bmp.height * base) / 2;
    const slider = h('input', { type: 'range', min: 1, max: 4, step: .01, value: 1, 'aria-label': 'Zoom' });
    const clamp = () => {
      ox = Math.min(0, Math.max(VW - bmp.width * base * zoom, ox));
      oy = Math.min(0, Math.max(VH - bmp.height * base * zoom, oy));
    };
    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0b1030'; ctx.fillRect(0, 0, VW, VH);
      ctx.drawImage(bmp, ox, oy, bmp.width * base * zoom, bmp.height * base * zoom);
    };
    const setZoom = (z, cx = VW / 2, cy = VH / 2) => {
      z = Math.min(4, Math.max(1, z));
      const k = z / zoom;
      ox = cx - (cx - ox) * k; oy = cy - (cy - oy) * k; zoom = z;
      clamp(); slider.value = z; draw();
    };
    slider.addEventListener('input', () => setZoom(+slider.value));

    let drag = null;
    cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, ox, oy }; });
    cv.addEventListener('pointermove', e => {
      if (!drag) return;
      ox = drag.ox + e.clientX - drag.x; oy = drag.oy + e.clientY - drag.y;
      clamp(); draw();
    });
    const end = () => { drag = null; };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    // het resultaat is precies wat je in het vak ziet
    const render = () => {
      const o = document.createElement('canvas'); o.width = outW; o.height = outH;
      const c = o.getContext('2d'), k = outW / VW;
      c.fillStyle = '#0b1030'; c.fillRect(0, 0, outW, outH);
      c.drawImage(bmp, ox * k, oy * k, bmp.width * base * zoom * k, bmp.height * base * zoom * k);
      for (const q of [.88, .75, .6, .45, .3]) {
        const s = o.toDataURL('image/jpeg', q);
        if (s.length <= maxLen) return s;
      }
      return null;
    };

    const dl = document.createElement('dialog');
    dl.className = 'crop-dlg';
    const done = (v) => { if (dl.open) dl.close(); dl.remove(); bmp.close?.(); resolve(v); };
    dl.addEventListener('cancel', e => { e.preventDefault(); done(null); });
    dl.append(h('div', { class: 'dlg-in' },
      h('h3', { text: title || (round ? 'Profielfoto bijsnijden' : 'Banner bijsnijden') }),
      h('p', { class: 'sub', text: 'Sleep de afbeelding om hem te verplaatsen en zoom met de schuifbalk of het muiswiel.' }),
      h('div', { class: 'crop-stage' }, cv),
      h('label', { class: 'crop-zl' }, h('span', { text: 'Zoom' }), slider),
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'ghost', type: 'button', text: 'Annuleren', onclick: () => done(null) }),
        h('button', { class: 'glow', type: 'button', text: 'Gebruiken', onclick: () => {
          const s = render();
          if (!s) { toast('Die afbeelding is te groot. Probeer een kleinere.'); return; }
          done(s);
        } }))));
    document.body.append(dl);
    dl.showModal();
    draw();
  });
}

/* --- eigen profiel bewerken (klik op je profielfoto) --- */
/* --- badges ---
   Definities staan in Firestore (collectie `badges`). Een badge met auto = 'memberSince' toont de dag waarop het account is gemaakt
   (users/{uid}.createdAt). De badges `plus` en `prime` (id, of veld auto = 'plus' / 'prime') zijn automatisch: ze staan er zolang het tier van
   die persoon plus / prime is en verdwijnen vanzelf als het tier weggaat. Alle andere badges tonen we als de uid in het veld `users` (array) staat. */
const BADGES = [];
const BADGE_ICONS = ['shield', 'calendar', 'star'];
const dateFmt = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
function badgeChips(uid, prof) {
  const out = [];
  const list = [...BADGES].sort((a, b) => (Number(a.order) || 99) - (Number(b.order) || 99) || String(a.name).localeCompare(String(b.name)));
  for (const b of list) {
    let extra = '';
    const tierAuto = ['plus', 'prime'].includes(b.auto) ? b.auto : ['plus', 'prime'].includes(b.id) ? b.id : '';
    if (tierAuto) {
      if (tierKey(prof) !== tierAuto) continue;
    } else if (b.auto === 'memberSince') {
      const t = prof?.createdAt?.toDate?.();
      if (!t) continue;
      extra = dateFmt.format(t);
    } else if (!(Array.isArray(b.users) && b.users.includes(uid))) continue;
    const color = HEX_RE.test(b.color) ? b.color : '#7c5cff';
    const ic = BADGE_ICONS.includes(b.icon)
      ? h('span', { class: 'bd-ic', html: I[b.icon] })
      : h('span', { class: 'bd-ic', text: String(b.icon || '★').slice(0, 4) });
    out.push(h('span', { class: 'badge', style: `--c:${color}`, title: String(b.description || b.name || '') },
      ic, h('b', { text: String(b.name || 'Badge') }), extra ? h('small', { text: extra }) : null));
  }
  return out;
}

function openProfileEditor() {
  const p = S.profile || {}, uid = S.me.uid, name = p.username || '?';
  const d = {
    avatar: safeImg(p.avatar), banner: safeBanner(p.banner), bio: p.bio || '', status: p.status || '',
    links: (p.links || []).filter(l => parseLink(l))
  };
  const myBadges = badgeChips(uid, p);
  const lockedUntil = (p.usernameChangedAt?.toMillis?.() || 0) + 7 * 864e5;
  const locked = lockedUntil > Date.now();
  const err = h('p', { class: 'err' });

  const setBanner = async (file) => { const s = await openCropper(file, 720, 240, { maxLen: 140000 }); if (s) { d.banner = s; paint(); } };
  const setAvatar = async (file) => { const s = await openCropper(file, 160, 160, { round: true, maxLen: 38000 }); if (s) { d.avatar = s; paint(); } };
  const choose = (fn) => async () => { const f = await pickFile(); if (f) fn(f); };

  const banner = h('button', { class: 'pf-banner', type: 'button', title: 'Klik of sleep een afbeelding', onclick: choose(setBanner) },
    h('span', { class: 'pf-cta', text: 'Klik of sleep een afbeelding' }));
  dropTarget(banner, setBanner);
  const av = h('span', { class: 'avatar big', style: '--s:88px' });
  const avBtn = h('button', { class: 'pf-av', type: 'button', title: 'Klik of sleep een afbeelding', onclick: choose(setAvatar) },
    av, h('span', { class: 'pf-cta', text: 'Wijzig' }));
  dropTarget(avBtn, setAvatar);

  const rmAv = h('button', { class: 'ghost sm', type: 'button', text: 'Foto verwijderen', onclick: () => { d.avatar = ''; paint(); } });
  const rmBanner = h('button', { class: 'ghost sm', type: 'button', text: 'Banner leegmaken', onclick: () => { d.banner = ''; paint(); } });

  // bannerkleur
  const color = h('input', { type: 'color', class: 'pf-color', title: 'Kies een kleur', 'aria-label': 'Bannerkleur' });
  color.value = HEX_RE.test(d.banner) ? d.banner : '#7c5cff';
  const useColor = (c) => { color.value = c; d.banner = c; paint(); };
  color.addEventListener('input', () => useColor(color.value));
  const swatches = ['#7c5cff', '#ff62d3', '#ffc857', '#38bdf8', '#43d17a', '#ff4d5e', '#1b1f3b'].map(c =>
    h('button', { class: 'sw', type: 'button', title: c, 'aria-label': 'Kleur ' + c, style: `background:${c}`, onclick: () => useColor(c) }));

  const paint = () => {
    banner.style.background = imgBg(d.banner, uid + 'b');
    paintBig(av, d.avatar, uid, name);
    rmAv.hidden = !d.avatar; rmBanner.hidden = !d.banner;
  };

  const nameInp = h('input', { class: 'inp', maxlength: 20, autocomplete: 'off', spellcheck: 'false' });
  nameInp.value = name; nameInp.disabled = locked;
  const nameNote = h('small', {
    class: 'count left',
    text: locked ? `Je kunt je naam weer wijzigen vanaf ${df.format(new Date(lockedUntil))}.` : 'Je kunt je gebruikersnaam één keer per week wijzigen.'
  });
  const statusInp = h('input', { class: 'inp', maxlength: 40, autocomplete: 'off', placeholder: 'Wat ben je aan het doen?' });
  statusInp.value = d.status;

  const ta = h('textarea', { class: 'inp', rows: 3, maxlength: 200, placeholder: 'Vertel iets over jezelf…' });
  ta.value = d.bio;
  const cnt = h('small', { class: 'count' });
  const upd = () => { cnt.textContent = `${ta.value.length}/200`; };
  ta.addEventListener('input', upd); upd();

  const chips = h('div', { class: 'chips' });
  const renderLinks = () => chips.replaceChildren(...d.links.map((l, i) => linkChip(l, () => { d.links.splice(i, 1); renderLinks(); })));
  const linkInp = h('input', { class: 'inp', maxlength: 200, autocomplete: 'off', placeholder: 'https://youtube.com/@jouwkanaal' });
  const note = h('p', { class: 'note' });
  const addLink = () => {
    note.className = 'note'; note.textContent = '';
    const bad = (t) => { note.textContent = t; note.className = 'note bad'; };
    const info = parseLink(linkInp.value);
    if (!info || info.href.length > 200) return bad('Dat is geen geldige link.');
    if (d.links.length >= 6) return bad('Je kunt maximaal 6 links toevoegen.');
    if (d.links.includes(info.href)) return bad('Deze link staat er al.');
    d.links.push(info.href); linkInp.value = ''; renderLinks();
  };
  linkInp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } });

  const save = h('button', { class: 'glow', type: 'button', text: 'Opslaan' });
  save.onclick = async () => {
    err.textContent = '';
    const newName = nameInp.value.trim();
    const rename = !locked && newName !== name;
    if (rename) {
      if (!/^[A-Za-z0-9_.]{2,20}$/.test(newName)) { err.textContent = 'Gebruikersnaam: 2–20 tekens, alleen letters, cijfers, _ en .'; return; }
      if (!confirm(`Je wordt "${newName}". Daarna kun je je naam een week lang niet meer wijzigen. Doorgaan?`)) return;
    }
    save.disabled = true;
    try {
      const batch = writeBatch(db);
      const upd = { status: statusInp.value.trim().slice(0, 40), bio: ta.value.trim().slice(0, 200), avatar: d.avatar, banner: d.banner, links: d.links };
      if (rename) {
        const oldL = p.usernameLower || name.toLowerCase(), lower = newName.toLowerCase();
        if (lower !== oldL) {
          if ((await getDoc(doc(db, 'usernames', lower))).exists()) { err.textContent = 'Deze gebruikersnaam is al bezet.'; return; }
          batch.delete(doc(db, 'usernames', oldL));
          batch.set(doc(db, 'usernames', lower), { uid });
        }
        Object.assign(upd, { username: newName, usernameLower: lower, usernameChangedAt: serverTimestamp() });
      }
      batch.update(doc(db, 'users', uid), upd);
      await batch.commit();
      closeDialog(); toast(rename ? `Je heet nu ${newName}.` : 'Profiel opgeslagen.');
    } catch (e) { err.textContent = fbErr(e); }
    finally { save.disabled = false; }
  };

  openDialog(
    h('h3', { text: 'Jouw profiel' }),
    banner,
    h('div', { class: 'pf-row' }, avBtn, h('div', { class: 'pf-rm' }, rmAv)),
    h('div', { class: 'pf-bar' },
      h('button', { class: 'ghost sm', type: 'button', text: 'Bannerafbeelding kiezen', onclick: choose(setBanner) }),
      h('label', { class: 'pf-colorl' }, 'of kleur', color),
      swatches, rmBanner),
    myBadges.length ? h('div', { class: 'pf-sec' }, h('h4', { text: 'Badges' }), h('div', { class: 'chips' }, myBadges)) : null,
    h('label', { class: 'lbl', text: 'Gebruikersnaam' }), nameInp, nameNote,
    h('label', { class: 'lbl', text: 'Status' }), statusInp,
    h('label', { class: 'lbl', text: 'Bio' }), ta, cnt,
    h('div', { class: 'pf-links' },
      h('h4', { text: 'Links' }),
      h('p', { class: 'sub', text: 'Plak een link naar een andere site. Hij verschijnt in je profiel als knop met het logo van de site.' }),
      h('div', { class: 'addrow' }, linkInp, h('button', { class: 'ghost', type: 'button', onclick: addLink, text: 'Toevoegen' })),
      note, chips),
    err,
    h('div', { class: 'dlg-actions' }, h('button', { class: 'ghost', type: 'button', onclick: closeDialog, text: 'Annuleren' }), save));
  dlg.classList.add('wide');
  paint(); renderLinks();
}

/* --- profiel van een ander bekijken --- */
async function openProfile(uid) {
  if (uid === S.me.uid) return openProfileEditor();
  let d = PROF[uid];
  try { const s = await getDoc(doc(db, 'users', uid)); if (s.exists()) d = s.data(); } catch {}
  if (!d) { toast('Profiel niet gevonden.'); return; }
  const f = accepted().find(x => otherId(x) === uid), st = presState(uid);
  const links = (d.links || []).map(l => linkChip(l)).filter(Boolean);
  const badges = badgeChips(uid, d);
  const av = h('span', { class: 'avatar big', style: '--s:88px' });
  paintBig(av, d.avatar, uid, d.username);
  openDialog(
    h('div', { class: 'pf-banner view', style: 'background:' + imgBg(d.banner, uid + 'b') }),
    h('div', { class: 'pf-row' }, av),
    h('h3', { text: d.username }),
    h('p', { class: 'pf-state' }, sIcon(st), [LABEL[st], d.status].filter(Boolean).join(' · ')),
    d.bio ? h('p', { class: 'pf-bio', text: d.bio }) : null,
    badges.length ? h('div', { class: 'pf-sec' }, h('h4', { text: 'Badges' }), h('div', { class: 'chips' }, badges)) : null,
    links.length ? h('div', { class: 'pf-sec' }, h('h4', { text: 'Links' }), h('div', { class: 'chips' }, links)) : null,
    h('div', { class: 'dlg-actions' },
      f ? h('button', { class: 'btn-ok', type: 'button', text: 'Bericht', onclick: () => { closeDialog(); S.activeDm = f.id; S.tab = 'dms'; renderTabs(); renderSidebar(); showMain(); } }) : null,
      h('button', { class: 'ghost', type: 'button', onclick: closeDialog, text: 'Sluiten' })));
  dlg.classList.add('wide');
}

// klik op een profielfoto (niet die in knoppen/dialogen) opent het profiel
document.addEventListener('click', e => {
  const a = e.target.closest('.avatar[data-uid]');
  if (!a || !S.me || a.closest('.item, dialog')) return;
  openProfile(a.dataset.uid);
});

// zijbalk (DM-lijst): foto aanklikken opent het profiel i.p.v. het gesprek, tenzij uitgezet in de instellingen
document.addEventListener('click', e => {
  if (!CFG.profileClick || !S.me) return;
  const a = e.target.closest('#sideList .item .avatar[data-uid]');
  if (!a) return;
  e.preventDefault(); e.stopPropagation();
  openProfile(a.dataset.uid);
}, true);

/* =====================  ongelezen berichten (rode teller bij DM's)  =====================
   Per vriend luisteren we naar de (max. 10) berichten van na het laatste moment dat je dat gesprek las.
   Dat moment bewaren we per apparaat in localStorage, dus het werkt ook als je leesbewijzen uit hebt staan. */
const UNREAD = { on: false, unsub: {}, ids: {} };
let LR = {};
const lrKey = () => 'infinitum-lastread-' + S.me.uid;
const saveLR = () => { try { localStorage.setItem(lrKey(), JSON.stringify(LR)); } catch {} };
const lastReadOf = (id) => Math.max(LR[id] || 0, LR._since || 0);
const unreadOf = (id) => UNREAD.ids[id]?.size || 0;
const unreadText = (n) => (n > 9 ? '9+' : String(n));
function unreadBadge(id) {
  const n = unreadOf(id);
  return n ? h('span', { class: 'unread', 'aria-label': `${n} ongelezen`, text: unreadText(n) }) : null;
}
function renderUnread() {
  const total = Object.values(UNREAD.ids).reduce((a, m) => a + m.size, 0);
  const bd = $('#dmBadge');
  if (bd) { bd.hidden = !total; bd.textContent = unreadText(total); }
  document.title = total ? `(${unreadText(total)}) Infinitum` : 'Infinitum';
  scheduleSidebar();
}
const isOpenDm = (id) => S.tab === 'dms' && S.activeDm === id && S.chat?.type === 'dm' && S.chat.id === id && isVisible() && document.hasFocus();
function markSeen(id) {
  const m = UNREAD.ids[id];
  const t = Math.max(S.chat?.id === id ? (S.chat.lastMillis || 0) : 0, ...(m ? [...m.values()] : [0]));
  const had = m?.size;
  if (t > (LR[id] || 0)) { LR[id] = t; saveLR(); }
  if (m) m.clear();
  if (had) renderUnread();
}
function seenOpenDm() { const c = S.chat; if (c?.type === 'dm' && isOpenDm(c.id)) markSeen(c.id); }
window.addEventListener('focus', seenOpenDm);
document.addEventListener('visibilitychange', seenOpenDm);

function syncUnread() {
  if (!S.me) return;
  if (!UNREAD.on) {
    UNREAD.on = true;
    try { LR = JSON.parse(localStorage.getItem(lrKey()) || '{}') || {}; } catch { LR = {}; }
    if (!LR._since) { LR._since = Date.now(); saveLR(); }   // oude berichten van voor het eerste gebruik tellen niet mee
  }
  const ids = new Set(accepted().map(f => f.id));
  for (const id of Object.keys(UNREAD.unsub)) {
    if (!ids.has(id)) { UNREAD.unsub[id](); delete UNREAD.unsub[id]; delete UNREAD.ids[id]; }
  }
  for (const id of ids) {
    if (UNREAD.unsub[id]) continue;
    UNREAD.ids[id] = new Map();
    const q = query(collection(db, 'chats', id, 'messages'),
      where('createdAt', '>', Timestamp.fromMillis(lastReadOf(id))), orderBy('createdAt', 'desc'), limit(10));
    UNREAD.unsub[id] = onSnapshot(q, snap => {
      const m = UNREAD.ids[id]; if (!m) return;
      for (const ch of snap.docChanges()) {
        if (ch.type === 'removed') { m.delete(ch.doc.id); continue; }
        const d = ch.doc.data({ serverTimestamps: 'estimate' });
        if (d.uid === S.me?.uid) continue;
        const t = d.createdAt?.toMillis?.() || Date.now();
        if (t > lastReadOf(id)) m.set(ch.doc.id, t);
      }
      if (isOpenDm(id)) markSeen(id); else renderUnread();
    }, () => {});
  }
  renderUnread();
}
function stopUnread() {
  for (const u of Object.values(UNREAD.unsub)) u();
  UNREAD.unsub = {}; UNREAD.ids = {}; UNREAD.on = false; LR = {};
  renderUnread();
}

/* =====================  abonnementen: Infinitum / Infinitum+ / Infinitum Prime  =====================
   - Functies per versie: Firestore -> features -> <id> { name, free, plus, prime, order }  (true = vinkje, false = kruis, tekst = die tekst)
   - Prijzen (optioneel): Firestore -> config -> plans { plusPrice, primePrice }
   - Aanvragen: Firestore -> subscriptions -> <uid> { username, tier, status: pending | approved | rejected, ... }
   - Moderators = de uid's in het veld `users` van het badge-document met id `moderator`.
   - Admins = dezelfde uid's als de moderators (badge-document `moderator`): beoordelen, abonnees beheren, de tabel aanpassen, eigen aanvraag goedkeuren.
   - Besluiten (goedkeuren, afwijzen, direct wijzigen) komen in subscriptions/<uid> te staan, met een optioneel bericht in `note`. */
const TIER_ORDER = ['free', 'plus', 'prime'];
const hasBadgeUser = (id) => !!S.me && BADGES.some(b => b.id === id && Array.isArray(b.users) && b.users.includes(S.me.uid));
const isAdmin = () => hasBadgeUser('moderator') || hasBadgeUser('admin');   // de moderator-badge is de admin-badge
const isMod = isAdmin;
const othersPending = () => SUB.pending.filter(r => r.uid !== S.me?.uid || isAdmin());   // alleen een admin mag zijn eigen aanvraag goedkeuren

function renderPremiumBadge() {
  const btn = $('#adminBtn'), mod = !!S.me && isMod();
  if (btn) {
    btn.hidden = !mod;
    const n = mod ? othersPending().length : 0, el = $('#admBadge');
    el.hidden = !n; el.textContent = unreadText(n);
  }
  const ib = $('#inboxBadge');
  if (ib) { const u = S.me ? unreadInbox() : 0; ib.hidden = !u; ib.textContent = unreadText(u); }
  if (S.tab === 'admin' || S.tab === 'inbox') scheduleSidebar();
}

// melding: toast als je kijkt, anders een bureaubladmelding
function inform(title, text, go = openPlans) {
  if (manualState() === 'dnd') return;
  if (isVisible() && document.hasFocus()) { toast(`${title}: ${text}`); return; }
  notify('requests', title, text, go);
}

// moderators luisteren naar alle openstaande aanvragen
function syncModWatch() {
  const want = isMod();
  if (want && !S.unsub.mods) {
    let primed = false;
    S.unsub.mods = onSnapshot(query(collection(db, 'subscriptions'), where('status', '==', 'pending')), snap => {
      SUB.pending = snap.docs.map(d => ({ uid: d.id, ...d.data({ serverTimestamps: 'estimate' }) }));
      if (primed) {
        for (const ch of snap.docChanges()) {
          if (ch.type !== 'added' || ch.doc.metadata.hasPendingWrites || ch.doc.id === S.me?.uid) continue;
          const d = ch.doc.data();
          inform(d.username || 'Iemand', `vraagt ${TIERS[d.tier]?.name || 'een abonnement'} aan — bekijk het formulier bij Admin.`, () => goPage('admin', 'requests'));
        }
      }
      primed = true;
      renderPremiumBadge(); adminView?.render(); plansView?.render();
    }, () => {});
  } else if (!want && S.unsub.mods) {
    S.unsub.mods(); S.unsub.mods = null; SUB.pending = [];
    renderPremiumBadge(); adminView?.render(); plansView?.render();
  }
}

async function requestTier(tier) {
  if (!S.me || tierKey(S.profile) === tier || !TIERS[tier] || tier === 'free') return;
  try {
    await setDoc(doc(db, 'subscriptions', S.me.uid), { username: S.profile?.username || 'Onbekend', tier, status: 'pending', requestedAt: serverTimestamp() });
    pushPing({ type: 'sub' });
    toast(`Aanvraag voor ${TIERS[tier].name} verstuurd. Een moderator keurt hem binnenkort goed.`);
  } catch (e) { toast(fbErr(e)); }
}
async function cancelRequest() {
  try { await deleteDoc(doc(db, 'subscriptions', S.me.uid)); toast('Aanvraag geannuleerd.'); }
  catch (e) { toast(fbErr(e)); }
}
async function decideRequest(r, ok, btns, note) {
  btns.forEach(b => { b.disabled = true; });
  try {
    const batch = writeBatch(db);
    const msg = String(note || '').trim().slice(0, 200);
    batch.update(doc(db, 'subscriptions', r.uid), { status: ok ? 'approved' : 'rejected', decidedBy: S.me.uid, decidedAt: serverTimestamp(), note: msg });
    if (ok) batch.update(doc(db, 'users', r.uid), { tier: r.tier });
    const nref = doc(collection(db, 'notifications'));
    batch.set(nref, notifDoc(r.uid, ok ? 'sub_approved' : 'sub_rejected',
      ok ? `${TIERS[r.tier]?.name} is geactiveerd` : `Je aanvraag voor ${TIERS[r.tier]?.name} is afgewezen`,
      msg || (ok ? 'Je aanvraag is goedgekeurd. Veel plezier!' : 'Je aanvraag is helaas niet goedgekeurd. Je kunt hem opnieuw aanvragen.')));
    await batch.commit();
    pushPing({ type: 'inbox', nid: nref.id });
    toast(ok ? `${r.username || 'Gebruiker'} heeft nu ${TIERS[r.tier]?.name}.` : `Aanvraag van ${r.username || 'gebruiker'} afgewezen.`);
  } catch (e) { toast(fbErr(e)); btns.forEach(b => { b.disabled = false; }); }
}

// admin: het abonnement van iemand direct wijzigen of stopzetten (tier = 'free'), met een optioneel bericht
async function adminSetTier(u, tier, note, btns) {
  btns.forEach(b => { b.disabled = true; });
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'subscriptions', u.uid), {
      username: String(u.username || 'Onbekend').slice(0, 20), tier, status: 'approved',
      decidedBy: S.me.uid, decidedAt: serverTimestamp(), note: String(note || '').trim().slice(0, 200)
    });
    batch.update(doc(db, 'users', u.uid), { tier });
    const msg = String(note || '').trim().slice(0, 200);
    const nref = doc(collection(db, 'notifications'));
    batch.set(nref, notifDoc(u.uid, 'sub_changed',
      tier === 'free' ? 'Je abonnement is stopgezet' : `Je hebt nu ${TIERS[tier].name}`,
      msg || (tier === 'free' ? 'Een moderator heeft je abonnement stopgezet.' : 'Een moderator heeft je abonnement gewijzigd.')));
    await batch.commit();
    pushPing({ type: 'inbox', nid: nref.id });
    toast(tier === 'free' ? `Abonnement van ${u.username || 'gebruiker'} is stopgezet.` : `${u.username || 'Gebruiker'} heeft nu ${TIERS[tier].name}.`);
  } catch (e) { toast(fbErr(e)); btns.forEach(b => { b.disabled = false; }); }
}

// admin-paneel: live lijst van alle mensen + recent beoordeelde aanvragen (alleen zolang het paneel openstaat)
const SUBS = { list: [], ready: false };
const UPG = { done: [], ready: false };
function stopAdminWatch() {
  S.unsub.subs?.(); S.unsub.subs = null; SUBS.list = []; SUBS.ready = false;
  S.unsub.upg?.(); S.unsub.upg = null; UPG.done = []; UPG.ready = false;
}
function syncSubsWatch() {
  const want = !!adminView && !!S.me && isAdmin();
  if (!want) { if (S.unsub.subs || S.unsub.upg) stopAdminWatch(); return; }
  if (!S.unsub.subs) {
    S.unsub.subs = onSnapshot(query(collection(db, 'users'), orderBy('usernameLower'), limit(500)), snap => {
      SUBS.list = snap.docs.map(d => { PROF[d.id] = d.data(); return { uid: d.id, ...d.data() }; });
      SUBS.ready = true;
      refreshAvatars(); adminView?.render();
    }, e => toast(fbErr(e)));
  }
  if (!S.unsub.upg) {
    S.unsub.upg = onSnapshot(query(collection(db, 'subscriptions'), where('status', 'in', ['approved', 'rejected']), limit(40)), snap => {
      UPG.done = snap.docs.map(d => ({ uid: d.id, ...d.data({ serverTimestamps: 'estimate' }) })).filter(r => r.requestedAt);
      UPG.ready = true; adminView?.render();
    }, e => toast(fbErr(e)));
  }
}

function featureCell(v, cur) {
  const c = cur ? ' cur' : '';
  if (v === true) return h('div', { class: 'pg-c yes' + c, html: I.check, role: 'img', 'aria-label': 'Inbegrepen' });
  if (typeof v === 'string' && v.trim()) return h('div', { class: 'pg-c txt' + c, text: v.trim().slice(0, 30) });
  return h('div', { class: 'pg-c no' + c, html: I.x, role: 'img', 'aria-label': 'Niet inbegrepen' });
}

function planAction(t, mine, sub) {
  if (mine === t) return h('span', { class: 'pg-tag ok', text: 'Jouw abonnement' });
  if (t === 'free') return null;
  if (sub?.status === 'pending' && sub.tier === t) {
    return h('div', { class: 'pg-pend' }, h('span', { class: 'pg-tag', text: 'In behandeling' }),
      h('button', { class: 'linkish', type: 'button', text: 'Annuleren', onclick: cancelRequest }));
  }
  const again = sub?.status === 'rejected' && sub.tier === t;
  return h('button', { class: 'glow sm', type: 'button', text: again ? 'Opnieuw aanvragen' : 'Aanvragen', onclick: () => { location.href = 'upgrade.html?tier=' + t; } });
}

const featSort = (a, b) => (Number.isFinite(+a.order) ? +a.order : 999) - (Number.isFinite(+b.order) ? +b.order : 999) || String(a.name).localeCompare(String(b.name));
const featureRows = () => [...(FEATURES.length ? FEATURES : DEFAULT_FEATURES)].filter(f => f && f.name).sort(featSort);

// admin: de tabel "welke functie zit in welk abonnement" aanpassen (Firestore -> features)
function buildFeatureEditor(onDone) {
  const seeded = !FEATURES.length;   // nog niets in Firestore: dan slaan we alle standaardrijen op
  const rows = featureRows().map(f => ({ id: f.id, orig: f, name: String(f.name), free: f.free, plus: f.plus, prime: f.prime }));
  const gone = [];
  const list = h('div', { class: 'fe-list' });
  const err = h('p', { class: 'err' });
  const mode = (v) => v === true ? 'yes' : (typeof v === 'string' && v.trim() ? 'txt' : 'no');
  const norm = (v) => v === true ? true : (typeof v === 'string' && v.trim() ? v.trim().slice(0, 30) : false);

  const cell = (r, t) => {
    const sel = h('select', { class: 'inp fe-sel', 'aria-label': TIERS[t].name },
      h('option', { value: 'yes', text: 'Ja' }), h('option', { value: 'no', text: 'Nee' }), h('option', { value: 'txt', text: 'Tekst' }));
    const txt = h('input', { class: 'inp fe-txt', maxlength: 30, placeholder: 'bijv. 10 MB', autocomplete: 'off' });
    sel.value = mode(r[t]); txt.value = typeof r[t] === 'string' ? r[t] : '';
    const sync = () => { txt.hidden = sel.value !== 'txt'; r[t] = sel.value === 'yes' ? true : sel.value === 'no' ? false : txt.value; };
    sel.addEventListener('change', sync); txt.addEventListener('input', sync); sync();
    return h('div', { class: 'fe-cell' }, h('small', { text: TIERS[t].name }), sel, txt);
  };

  const paint = () => {
    list.replaceChildren(...rows.map((r, i) => {
      const nm = h('input', { class: 'inp fe-name', maxlength: 60, autocomplete: 'off', placeholder: 'Naam van de functie' });
      nm.value = r.name; nm.addEventListener('input', () => { r.name = nm.value; });
      const move = (d) => () => { const j = i + d; if (j < 0 || j >= rows.length) return; [rows[i], rows[j]] = [rows[j], rows[i]]; paint(); };
      return h('div', { class: 'fe-row' },
        h('div', { class: 'fe-top' }, nm,
          h('button', { class: 'ghost sm', type: 'button', html: I.up, title: 'Omhoog', 'aria-label': 'Omhoog', disabled: i === 0, onclick: move(-1) }),
          h('button', { class: 'ghost sm', type: 'button', html: I.down, title: 'Omlaag', 'aria-label': 'Omlaag', disabled: i === rows.length - 1, onclick: move(1) }),
          h('button', { class: 'btn-no', type: 'button', html: I.trash, title: 'Verwijderen', 'aria-label': 'Functie verwijderen',
            onclick: () => { const [x] = rows.splice(i, 1); if (x.id) gone.push(x.id); paint(); } })),
        h('div', { class: 'fe-cells' }, TIER_ORDER.map(t => cell(r, t))));
    }));
  };

  const close = () => onDone?.();
  const add = h('button', { class: 'ghost sm', type: 'button', text: '+ Functie toevoegen', onclick: () => {
    rows.push({ id: null, orig: null, name: '', free: false, plus: false, prime: false }); paint();
    list.lastElementChild?.querySelector('.fe-name')?.focus();
  } });
  const cancel = h('button', { class: 'ghost', type: 'button', text: 'Annuleren', onclick: close });
  const save = h('button', { class: 'glow', type: 'button', text: 'Tabel opslaan' });
  save.onclick = async () => {
    err.textContent = '';
    if (rows.some(r => !r.name.trim())) { err.textContent = 'Elke functie heeft een naam nodig.'; return; }
    save.disabled = true;
    try {
      const ops = [];
      rows.forEach((r, i) => {
        const data = { name: r.name.trim().slice(0, 60), order: i + 1, free: norm(r.free), plus: norm(r.plus), prime: norm(r.prime) };
        const o = r.orig;
        const same = !seeded && o && o.name === data.name && +o.order === data.order && norm(o.free) === data.free && norm(o.plus) === data.plus && norm(o.prime) === data.prime;
        if (same) return;
        ops.push(setDoc(doc(db, 'features', r.id || doc(collection(db, 'features')).id), data));
      });
      for (const id of gone) ops.push(deleteDoc(doc(db, 'features', id)));
      await Promise.all(ops);
      toast('Tabel opgeslagen.');
      close();
    } catch (e) { err.textContent = fbErr(e); }
    finally { save.disabled = false; }
  };

  paint();
  return h('div', { class: 'fe' },
    h('h4', { class: 'plans-sec', text: 'Tabel bewerken' }),
    h('p', { class: 'hint', text: 'Kies per versie of de functie erbij zit (Ja), niet erbij zit (Nee) of een eigen tekst heeft. Met de pijltjes verander je de volgorde.' }),
    list, add, err,
    h('div', { class: 'dlg-actions' }, cancel, save));
}

// admin: één abonnee beheren (ander abonnement kiezen of stopzetten, met optioneel bericht)
function subscriberRow(u) {
  const cur = tierKey(u);
  const sel = h('select', { class: 'inp', 'aria-label': 'Abonnement van ' + (u.username || 'gebruiker') },
    TIER_ORDER.map(t => h('option', { value: t, text: t === 'free' ? 'Gratis (stopzetten)' : TIERS[t].name })));
  sel.value = cur;
  const note = h('input', { class: 'inp', maxlength: 200, autocomplete: 'off', placeholder: 'Bericht aan de gebruiker (optioneel) — bijv. waarom je het abonnement wijzigt' });
  const go = h('button', { class: 'btn-ok', type: 'button', text: 'Toepassen' });
  go.onclick = () => {
    if (sel.value === cur) { toast('Kies eerst een ander abonnement.'); return; }
    adminSetTier(u, sel.value, note.value, [go]);
  };
  return h('div', { class: 'row plan-req sub-row' },
    avatar(u.uid, u.username, 40, true),
    h('span', { class: 'item-text' }, h('b', { text: u.username || 'Onbekend' }), h('small', { text: TIERS[cur].name + (BADGES.some(b => b.id === 'moderator' && Array.isArray(b.users) && b.users.includes(u.uid)) ? ' · moderator' : '') })),
    h('div', { class: 'row-actions' }, sel, go, h('button', { class: 'ghost sm', type: 'button', text: 'Profiel resetten', onclick: () => openResetDialog(u) })),
    note);
}

function buildPlans() {
  const mine = tierKey(S.profile), sub = SUB.mine, out = [];

  // status voor de gebruiker zelf
  const subName = sub ? (TIERS[sub.tier]?.name || 'abonnement') : '';
  let st;
  if (sub?.status === 'pending') st = ['pend', `Je aanvraag voor ${subName} is verstuurd. Een moderator moet hem nog goedkeuren. Je krijgt een melding zodra hij is beoordeeld.`];
  else if (sub?.status === 'rejected' && mine !== sub.tier) st = ['bad', `Je aanvraag voor ${subName} is afgewezen. Je kunt hem opnieuw aanvragen.`];
  else if (sub?.status === 'approved' && sub.tier === 'free' && mine === 'free') st = ['info', 'Je abonnement is stopgezet. Je gebruikt nu het gratis Infinitum.'];
  else if (mine !== 'free') st = ['ok', `Je hebt ${TIERS[mine].name}. Je abonnement is geactiveerd.`];
  else st = ['info', 'Je gebruikt nu het gratis Infinitum. Je abonnement is nog niet geactiveerd.'];
  const showNote = sub && sub.status !== 'pending' && sub.note && (sub.status === 'approved' ? sub.tier === mine : mine !== sub.tier);
  out.push(h('p', { class: 'plan-status ' + st[0] }, st[1], showNote ? h('span', { class: 'plan-note', text: 'Bericht van de moderator: ' + sub.note }) : null));

  // vergelijking
  {
    const rows = featureRows();
    const grid = h('div', { class: 'plan-grid' }, h('div', { class: 'pg-h pg-corner' }));
    for (const t of TIER_ORDER) {
      grid.append(h('div', { class: 'pg-h' + (mine === t ? ' cur' : '') },
        h('img', { class: 'pg-ic', src: TIERS[t].icon, alt: '' }),
        h('b', { text: TIERS[t].name }),
        h('small', { text: t === 'free' ? 'Gratis' : String(PLANCFG[t + 'Price'] || '') })));
    }
    for (const f of rows) {
      grid.append(h('div', { class: 'pg-f', text: String(f.name) }));
      for (const t of TIER_ORDER) grid.append(featureCell(f[t], mine === t));
    }
    grid.append(h('div', { class: 'pg-a pg-corner' }));
    for (const t of TIER_ORDER) grid.append(h('div', { class: 'pg-a' + (mine === t ? ' cur' : '') }, planAction(t, mine, sub)));
    out.push(h('div', { class: 'plan-scroll' }, grid));
  }

  out.push(h('p', { class: 'plan-how', text: 'Zo werkt het: klik bij een versie op Aanvragen en vul het formulier in. Een moderator beoordeelt je aanvraag, daarna wordt je abonnement geactiveerd en zie je dat hier.' }));

  return out;
}

/* =====================  meldingen (inbox), voor iedereen  =====================
   Firestore -> notifications -> <id> { uid (ontvanger), type, title, text, by, byName, createdAt, read }
   Moderators maken ze aan bij een besluit of een profielwijziging; bij een aanvraag maakt de aanvrager er zelf een. */
const INBOX = { list: [], ready: false };
const NAV = { admin: 'requests', inbox: 'all' };
const PAGES = ['settings', 'admin', 'inbox'];
const unreadInbox = () => INBOX.list.filter(n => !n.read).length;
const NT_ICON = { sub_request: I.star, sub_approved: I.check, sub_rejected: I.x, sub_changed: I.star, profile_reset: I.user, message: I.bell, mention: I.at };
const NT_FILTERS = [
  { id: 'all', title: 'Alles', d: 'Alle meldingen', ic: I.bell },
  { id: 'unread', title: 'Ongelezen', d: 'Nog niet gelezen', ic: I.eye },
  { id: 'sub', title: 'Abonnement', d: 'Aanvragen en besluiten', ic: I.star },
  { id: 'mention', title: 'Vermeldingen', d: 'Berichten waarin je getagd bent', ic: I.at },
  { id: 'profile', title: 'Profiel', d: 'Wijzigingen door een moderator', ic: I.user }
];
const ntMatch = (n, f) => f === 'all' || (f === 'unread' && !n.read) || (f === 'sub' && String(n.type).startsWith('sub_')) || (f === 'mention' && n.type === 'mention') || (f === 'profile' && n.type === 'profile_reset');

const notifDoc = (uid, type, title, text) => ({
  uid, type, title: String(title).slice(0, 80), text: String(text || '').slice(0, 400),
  by: S.me.uid, byName: String(S.profile?.username || 'Moderator').slice(0, 20), createdAt: serverTimestamp(), read: false
});

function startInbox(uid) {
  let primed = false;
  S.unsub.inbox = onSnapshot(query(collection(db, 'notifications'), where('uid', '==', uid), limit(200)), snap => {
    INBOX.list = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }))
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    INBOX.ready = true;
    if (primed) {
      for (const ch of snap.docChanges()) {
        if (ch.type !== 'added' || ch.doc.metadata.hasPendingWrites) continue;
        const d = ch.doc.data();
        if (d.type === 'mention') { if (!(S.chat?.type === 'server' && S.chat.id === d.sid && S.chat.cid === d.cid && isVisible() && document.hasFocus())) notify('mention', d.title || 'Vermelding', d.text || '', () => applyOpen(d.open), d.open || ''); }
        else if (d.type !== 'sub_request') inform(d.title || 'Melding', d.text || '', () => goPage('inbox'));
      }
    }
    primed = true;
    renderPremiumBadge();
    if (S.tab === 'inbox') inboxRender();
  }, e => console.error(e));
}

// pagina's (Admin, Meldingen) werken net als de instellingen: terug naar waar je was met dezelfde knop
function goPage(tab, sec) {
  if (sec) NAV[tab] = sec;
  if (S.tab === tab) { renderSidebar(); showMain(); return; }
  S.prevTab = PAGES.includes(S.tab) ? (PAGES.includes(S.prevTab) || !S.prevTab ? 'dms' : S.prevTab) : S.tab;
  setTab(tab);
}
function togglePage(tab) {
  if (S.tab === tab) setTab(S.prevTab && !PAGES.includes(S.prevTab) ? S.prevTab : 'dms');
  else goPage(tab);
}

// gedeelde zijbalk voor Admin en Meldingen
function buildPageNav(list, foot) {
  const admin = S.tab === 'admin';
  const items = admin ? ADM_SECS.map(x => ({ ...x, badge: x.id === 'requests' ? othersPending().length : 0 }))
    : NT_FILTERS.map(x => ({ ...x, badge: x.id === 'unread' ? unreadInbox() : 0 }));
  list.replaceChildren(...items.map(x => h('button', {
    class: 'item set-nav' + (NAV[S.tab] === x.id ? ' active' : ''), type: 'button',
    onclick: () => { NAV[S.tab] = x.id; renderSidebar(); showMain('main'); }
  },
    h('span', { class: 'set-ic', html: x.ic }),
    h('span', { class: 'item-text' }, h('b', { text: x.title }), h('small', { text: x.d })),
    x.badge ? h('span', { class: 'unread', text: unreadText(x.badge) }) : null)));
  foot.replaceChildren();
}

const pageHead = (title, sub) => h('div', { class: 'set-head' },
  h('button', { class: 'icon-btn back', type: 'button', html: I.back, 'aria-label': 'Terug', onclick: () => setView('list') }),
  h('div', {}, h('h2', { text: title }), h('p', { class: 'sub', text: sub })));

async function ntMark(list) {
  const todo = list.filter(n => !n.read).slice(0, 400);
  if (!todo.length) return;
  try { const b = writeBatch(db); todo.forEach(n => b.update(doc(db, 'notifications', n.id), { read: true })); await b.commit(); }
  catch (e) { toast(fbErr(e)); }
}
async function ntDelete(list) {
  try { const b = writeBatch(db); list.slice(0, 400).forEach(n => b.delete(doc(db, 'notifications', n.id))); await b.commit(); }
  catch (e) { toast(fbErr(e)); }
}

function inboxRender() {
  const box = $('#ntList'); if (!box) return;
  const f = NAV.inbox, rows = INBOX.list.filter(n => ntMatch(n, f));
  const bar = $('#ntBar');
  if (bar) bar.replaceChildren(
    h('button', { class: 'ghost sm', type: 'button', text: 'Alles als gelezen', disabled: !rows.some(n => !n.read), onclick: () => ntMark(rows) }),
    h('button', { class: 'ghost sm', type: 'button', text: 'Alles wissen', disabled: !rows.length, onclick: () => { if (confirm(`${rows.length} melding${rows.length === 1 ? '' : 'en'} wissen?`)) ntDelete(rows); } }));
  if (!INBOX.ready) { box.replaceChildren(h('p', { class: 'hint', text: 'Laden…' })); return; }
  if (!rows.length) { box.replaceChildren(h('p', { class: 'hint', text: f === 'unread' ? 'Je hebt alles gelezen. 🎉' : 'Hier staan nog geen meldingen.' })); return; }
  const out = []; let day = '';
  for (const n of rows) {
    const d = n.createdAt?.toDate?.() || new Date();
    const dk = dayKey(d);
    if (dk !== day) { day = dk; out.push(h('h4', { class: 'plans-sec', text: dayLabel(d) })); }
    const from = n.type === 'sub_request' ? 'Jij' : n.type === 'mention' ? (n.byName || 'Iemand') : `Moderator ${n.byName || ''}`.trim();
    out.push(h('div', {
      class: 'nt-card' + (n.read ? '' : ' new'), role: 'button', tabindex: '0',
      onclick: () => { if (!n.read) updateDoc(doc(db, 'notifications', n.id), { read: true }).catch(() => {}); if (n.type === 'mention' && n.open) applyOpen(n.open); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!n.read) updateDoc(doc(db, 'notifications', n.id), { read: true }).catch(() => {}); if (n.type === 'mention' && n.open) applyOpen(n.open); } }
    },
      h('span', { class: 'nt-ic t-' + n.type, html: NT_ICON[n.type] || I.bell }),
      h('div', { class: 'nt-text' },
        h('b', { text: n.title || 'Melding' }),
        n.text ? h('p', { text: n.text }) : null,
        h('small', { text: `${from} · ${tf.format(d)}` })),
      h('button', {
        class: 'icon-btn', type: 'button', html: I.trash, title: 'Verwijderen', 'aria-label': 'Melding verwijderen',
        onclick: (e) => { e.stopPropagation(); deleteDoc(doc(db, 'notifications', n.id)).catch(err => toast(fbErr(err))); }
      })));
  }
  box.replaceChildren(...out);
}

function renderInbox() {
  const f = NT_FILTERS.find(x => x.id === NAV.inbox) || NT_FILTERS[0];
  $('#main').replaceChildren(h('div', { class: 'pane inboxpg' },
    pageHead('Meldingen', 'Alles wat moderators en abonnementen naar jou sturen, zodat je het kunt terugzien. ' + f.d + '.'),
    h('div', { class: 'nt-bar', id: 'ntBar' }),
    h('div', { id: 'ntList' })));
  inboxRender();
}

/* =====================  Admin-pagina (knop "Admin", alleen voor moderators)  =====================
   Zijbalk: Aanvragen (formulieren van upgrade.html beoordelen), Mensen (beheren + profiel resetten), Tabel (functies per versie). */
const ADM_SECS = [
  { id: 'requests', title: 'Aanvragen', d: 'Upgrade-aanvragen beoordelen', ic: I.star, sub: 'Formulieren van mensen die een abonnement willen. Keur ze goed of wijs ze af; de gebruiker krijgt een melding met jouw reactie.' },
  { id: 'people', title: 'Mensen', d: 'Beheren en profielen resetten', ic: I.user, sub: 'Alle Infinitum-gebruikers: abonnement wijzigen, of een profiel en gebruikersnaam resetten.' },
  { id: 'table', title: 'Tabel', d: 'Functies per versie', ic: I.check, sub: 'Welke functie bij welk abonnement hoort.' }
];
const fmtWhen = (t) => { const d = t?.toDate?.(); return d ? `${dayLabel(d)} ${tf.format(d)}` : ''; };

function upgCard(r) {
  const f = r.form || null, prof = PROF[r.uid];
  const since = prof?.createdAt?.toDate?.();
  const cur = TIERS[tierKey(prof)]?.name;
  const field = (label, value) => value ? h('div', { class: 'upg-f' }, h('small', { text: label }), h('p', { text: value })) : null;
  const ok = h('button', { class: 'btn-ok', type: 'button', text: 'Goedkeuren' });
  const no = h('button', { class: 'btn-no', type: 'button', text: 'Afwijzen' });
  const note = h('input', { class: 'inp', maxlength: 200, autocomplete: 'off', placeholder: 'Reactie aan de gebruiker (optioneel)' });
  ok.onclick = () => decideRequest(r, true, [ok, no], note.value);
  no.onclick = () => decideRequest(r, false, [ok, no], note.value);
  const feats = Array.isArray(f?.features) ? f.features.filter(x => typeof x === 'string').slice(0, 12) : [];
  return h('div', { class: 'upg-card' },
    h('div', { class: 'upg-top' },
      avatar(r.uid, r.username, 44, true),
      h('span', { class: 'item-text' },
        h('b', { text: (r.username || 'Onbekend') + (r.uid === S.me.uid ? ' (jij)' : '') }),
        h('small', { text: [cur ? `nu ${cur}` : '', since ? `account sinds ${dateFmt.format(since)}` : '', fmtWhen(r.requestedAt)].filter(Boolean).join(' · ') })),
      h('span', { class: 'upg-tier t-' + r.tier, text: TIERS[r.tier]?.name || 'Abonnement' })),
    f ? h('div', { class: 'upg-form' },
      field('Waarom wil de gebruiker upgraden?', f.reason),
      feats.length ? h('div', { class: 'upg-f' }, h('small', { text: 'Wil vooral gebruiken' }), h('div', { class: 'chips' }, feats.map(x => h('span', { class: 'upg-chip', text: x })))) : null,
      field('Opmerking', f.extra))
      : h('p', { class: 'hint', text: 'Bij deze aanvraag is geen formulier ingevuld.' }),
    h('div', { class: 'upg-act' }, note, ok, no));
}

function buildRequests() {
  const out = [];
  const pend = othersPending().sort((a, b) => (a.requestedAt?.toMillis?.() || 0) - (b.requestedAt?.toMillis?.() || 0));
  loadProfiles(pend.map(r => r.uid));
  out.push(h('h4', { class: 'plans-sec', text: `Openstaande aanvragen — ${pend.length}` }));
  if (!pend.length) out.push(h('p', { class: 'hint', text: 'Er zijn geen openstaande aanvragen.' }));
  pend.forEach(r => out.push(upgCard(r)));

  const done = [...UPG.done].sort((a, b) => (b.decidedAt?.toMillis?.() || 0) - (a.decidedAt?.toMillis?.() || 0));
  out.push(h('h4', { class: 'plans-sec', text: 'Recent beoordeeld' }));
  if (!UPG.ready) out.push(h('p', { class: 'hint', text: 'Laden…' }));
  else if (!done.length) out.push(h('p', { class: 'hint', text: 'Nog niets beoordeeld.' }));
  for (const r of done) {
    out.push(h('div', { class: 'row upg-done' },
      avatar(r.uid, r.username, 36, true),
      h('span', { class: 'item-text' },
        h('b', { text: r.username || 'Onbekend' }),
        h('small', { text: `${TIERS[r.tier]?.name || ''} · ${fmtWhen(r.decidedAt)}` + (r.note ? ` · ${r.note}` : '') })),
      h('span', { class: 'upg-st ' + r.status, text: r.status === 'approved' ? 'Goedgekeurd' : 'Afgewezen' })));
  }
  return out;
}

// profiel en/of gebruikersnaam van iemand resetten, met een verplichte reactie die de gebruiker als melding krijgt
function openResetDialog(u) {
  const label = (cb, t, d) => h('label', { class: 'up-check rs-opt' }, cb, h('span', { class: 'item-text' }, h('b', { text: t }), h('small', { text: d })));
  const cbName = h('input', { type: 'checkbox' }), cbProf = h('input', { type: 'checkbox' });
  const msg = h('textarea', { class: 'inp', rows: 3, maxlength: 200, placeholder: 'Reactie aan de gebruiker, bijv. waarom je dit doet (verplicht)' });
  const err = h('p', { class: 'err' });
  const go = h('button', { class: 'btn-ok', type: 'button', text: 'Resetten' });
  go.onclick = async () => {
    err.textContent = '';
    const text = msg.value.trim();
    if (!cbName.checked && !cbProf.checked) { err.textContent = 'Kies wat je wilt resetten.'; return; }
    if (text.length < 5) { err.textContent = 'Schrijf een korte reactie voor de gebruiker (minimaal 5 tekens).'; return; }
    go.disabled = true;
    try { await resetProfile(u, { name: cbName.checked, prof: cbProf.checked, text }); closeDialog(); }
    catch (e) { err.textContent = fbErr(e); go.disabled = false; }
  };
  openDialog(
    h('h3', { text: `${u.username || 'Gebruiker'} resetten` }),
    h('p', { class: 'sub', text: 'De gebruiker krijgt hiervan een melding met jouw reactie.' }),
    label(cbName, 'Gebruikersnaam', 'Wordt vervangen door een automatische naam (gebruiker1234). De gebruiker kan zelf later weer een naam kiezen.'),
    label(cbProf, 'Profiel', 'Wist profielfoto, banner, bio, links en status.'),
    h('label', { class: 'lbl', text: 'Reactie' }), msg, err,
    h('div', { class: 'dlg-actions' }, h('button', { class: 'ghost', type: 'button', onclick: closeDialog, text: 'Annuleren' }), go));
}

async function resetProfile(u, { name, prof, text }) {
  const batch = writeBatch(db), upd = {}, did = [];
  if (prof) {
    Object.assign(upd, { avatar: '', banner: '', bio: '', links: [], status: '' });
    did.push('je profielfoto, banner, bio, links en status zijn gewist');
  }
  if (name) {
    let nn = '';
    for (let i = 0; i < 8 && !nn; i++) {
      const cand = 'gebruiker' + (1000 + Math.floor(Math.random() * 9000));
      if (!(await getDoc(doc(db, 'usernames', cand))).exists()) nn = cand;
    }
    if (!nn) throw new Error('Kon geen vrije gebruikersnaam vinden. Probeer het nog eens.');
    const old = u.usernameLower || String(u.username || '').toLowerCase();
    if (old) batch.delete(doc(db, 'usernames', old));
    batch.set(doc(db, 'usernames', nn), { uid: u.uid });
    Object.assign(upd, { username: nn, usernameLower: nn });
    did.push(`je gebruikersnaam is nu ${nn}`);
  }
  batch.update(doc(db, 'users', u.uid), upd);
  const nref = doc(collection(db, 'notifications'));
  batch.set(nref, notifDoc(u.uid, 'profile_reset', 'Je profiel is aangepast door een moderator',
    `${text}\n\nWat er is aangepast: ${did.join('; ')}.`));
  await batch.commit();
  pushPing({ type: 'inbox', nid: nref.id });
  toast(`${u.username || 'Gebruiker'} is gereset.`);
}

function renderAdmin() {
  const sec = ADM_SECS.find(x => x.id === NAV.admin) || ADM_SECS[0];
  const body = h('div', { class: 'adm-pane' });
  const search = h('input', { class: 'inp', type: 'search', placeholder: 'Zoek een gebruiker…', autocomplete: 'off', 'aria-label': 'Zoek een gebruiker' });
  const count = h('h4', { class: 'plans-sec' });
  const list = h('div');
  const reqBox = h('div');
  let dirty = false;

  const paintPeople = () => {
    const q = search.value.trim().toLowerCase();
    const rows = SUBS.list.filter(u => !q || String(u.username || '').toLowerCase().includes(q))
      .sort((a, b) => TIER_ORDER.indexOf(tierKey(b)) - TIER_ORDER.indexOf(tierKey(a)) || String(a.username).localeCompare(String(b.username)));
    count.textContent = `Mensen — ${rows.length}${q ? ' gevonden' : ''}`;
    if (!SUBS.ready) list.replaceChildren(h('p', { class: 'hint', text: 'Laden…' }));
    else if (!rows.length) list.replaceChildren(h('p', { class: 'hint', text: 'Niemand gevonden.' }));
    else list.replaceChildren(...rows.slice(0, 100).map(subscriberRow),
      ...(rows.length > 100 ? [h('p', { class: 'hint', text: 'De eerste 100 worden getoond. Gebruik het zoekveld om iemand te vinden.' })] : []));
  };
  search.addEventListener('input', paintPeople);

  const inField = () => body.contains(document.activeElement) && document.activeElement !== search && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  const render = () => {
    if (sec.id === 'table') return;
    if (inField()) { dirty = true; return; }   // niet opnieuw tekenen terwijl een moderator typt
    dirty = false;
    if (sec.id === 'requests') reqBox.replaceChildren(...buildRequests());
    else paintPeople();
  };
  body.addEventListener('focusout', () => setTimeout(() => { if (dirty && !inField()) render(); }, 0));

  if (sec.id === 'requests') body.append(reqBox);
  else if (sec.id === 'people') body.append(search, count, list);
  else body.append(buildFeatureEditor(() => renderAdmin()));

  adminView = { render };
  $('#main').replaceChildren(h('div', { class: 'pane adminpg' }, pageHead(sec.title, sec.sub), body));
  syncSubsWatch();
  render();
}

$('#adminBtn').addEventListener('click', () => togglePage('admin'));
$('#inboxBtn').innerHTML = I.bell + '<span class="bell-t">Meldingen</span><span class="unread" id="inboxBadge" hidden></span>';
$('#inboxBtn').addEventListener('click', () => togglePage('inbox'));

function openPlans() {
  if (!S.me) return;
  const body = h('div');
  // niet opnieuw tekenen terwijl iemand in een invoerveld typt (anders raakt de tekst kwijt als er live data binnenkomt)
  const inField = () => body.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  plansView = {
    editing: false, editor: null, dirty: false,
    render() { if (inField()) { this.dirty = true; return; } this.dirty = false; body.replaceChildren(...buildPlans()); }
  };
  body.addEventListener('focusout', () => setTimeout(() => { if (plansView?.dirty && !inField()) plansView.render(); }, 0));
  openDialog(
    h('h3', { text: 'Infinitum Premium' }),
    h('p', { class: 'sub', text: 'Vergelijk de versies en vraag een abonnement aan via een kort formulier.' }),
    body,
    h('div', { class: 'dlg-actions' }, h('button', { class: 'ghost', type: 'button', onclick: closeDialog, text: 'Sluiten' })));
  dlg.classList.add('plans');
  plansView.render();
  syncSubsWatch();
}
$('#premiumBtn').addEventListener('click', openPlans);

applyAppearance();
setMode('login');
