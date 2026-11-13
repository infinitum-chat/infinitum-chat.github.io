/* =====================  Streakr (v0.16)  =====================
   Streaks zoals op Snapchat: stuur elke dag allebei minstens één streakr (een foto die je maar 1x kunt bekijken)
   en je streak groeit. Dit bestand bevat alles: de Streakr-pagina, de camera, de viewer, de top 10, herstellen
   en de badge. app.js geeft via createStreakr({...}) de benodigde hulpfuncties mee.

   Firestore:
   - streaks/{pairId}    pairId = zelfde id als de vriendschap. { users, names, count, day, sent{uid: dag}, lost, best, incAt, updatedAt }
   - snaps/{id}          { from, to, pair, name, createdAt, src 'cld'|'data', img, w, h, secs, views, state 'new'|'opened'|'gone', openedAt }
   - streakUsers/{uid}   { used }  = hoeveel herstellers je (Prime) al gebruikte
   Een "dag" is een kalenderdag in Nederlandse tijd (Europe/Amsterdam). */
import { db } from './firebase.js?v=0.28';
import {
  collection, doc, getDocs, onSnapshot, query, where, orderBy, limit,
  updateDoc, setDoc, deleteDoc, writeBatch, runTransaction, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';

const FLAME = 'assets/streakr-flame.svg';
const TZ = 'Europe/Amsterdam';
const dayFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayStr = (ms = Date.now()) => dayFmt.format(ms);
const dayNum = (s) => Math.round(Date.parse(s + 'T00:00:00Z') / 864e5);
const todayNum = () => dayNum(dayStr());
const SAND_H = 5;   // het zandlopertje verschijnt pas als er nog maar 5 uur over zijn
const hoursLeft = () => { const [hh, mm] = hourFmt.format(Date.now()).split(':').map(Number); return 24 - (hh + mm / 60); };

const BASE_RESTORES = 3;                       // Prime: zoveel herstellers heb je
const bonusRestores = (best) => best >= 100 ? Math.floor((best - 100) / 200) + 1 : 0;   // +1 bij 100, 300, 500, 700, ... dagen
const IMG_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
const MAX_DATA = 150000;                       // max. lengte van een foto die direct in Firestore staat (zonder Cloudinary)
const BASE_MAX = 1280;                         // grootste kant van de foto die je maakt/kiest (Cloudinary-kwaliteit zit hier bovenop)
// v0.16: kwaliteit per opslagplek. Cloudinary = goed (scherp), Firestore = laag (klein genoeg voor in een document)
const Q_CLOUD = { side: 1280, q: .85 }, Q_FIRE = { side: 640, q: .45 };
const SNAP_TTL = 30 * 864e5;
const CHAT_TTL = 24 * 36e5;                    // een geopend streakr blijft nog 24 uur als blokje in de chat staan

const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const IC = {
  cam: svg('<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.7"/>'),
  flip: svg('<path d="M20 7H8a5 5 0 0 0-5 5M4 17h12a5 5 0 0 0 5-5M17 4l3 3-3 3M7 20l-3-3 3-3"/>'),
  img: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-8 9"/>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  chat: svg('<path d="M21 12a8 8 0 0 1-11.7 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'),
  send: svg('<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>')
};

export function createStreakr(X) {
  const { h, $, S } = X;
  const ST = {
    streaks: {}, snapsIn: [], snapsOut: [], used: 0, ready: false, cfg: { storage: '' }, cfgSubs: new Set(),
    top: { list: [], at: 0, busy: null }, unsub: [], firstIn: true, settling: new Set(), busy: new Set(), raf: 0
  };

  /* ---------------- hulpjes: status van een streak ---------------- */
  const maxViews = () => X.tierAtLeast('prime') ? 3 : X.tierAtLeast('plus') ? 2 : 1;   // gratis 1x, Plus 2x (1 extra), Prime 3x (2 extra)
  const myUid = () => S.me?.uid;
  // waar nieuwe streakr-foto's heen gaan: admin-keuze (config/streakr.storage); zonder keuze Cloudinary, en zonder Cloudinary-instellingen altijd Firestore
  const storageMode = () => (ST.cfg.storage === 'firestore' || !X.cloudOn) ? 'firestore' : 'cloudinary';
  // 'alive' (loopt), 'lost' (afgelopen, eventueel te herstellen) of 'none'
  function stateOf(id) {
    const d = ST.streaks[id];
    if (!d) return { kind: 'none', d: null, lost: 0 };
    const gap = d.day ? todayNum() - dayNum(d.day) : 99;
    if (d.count > 0 && gap <= 1) return { kind: 'alive', d, count: d.count, gap, lost: d.lost || 0 };
    if (d.count >= 2 && gap > 1) return { kind: 'lost', d, count: 0, gap, lost: d.count };          // verlopen, nog niet opgeruimd
    if ((d.lost || 0) > 0) return { kind: 'lost', d, count: 0, gap, lost: d.lost };
    return { kind: 'none', d, count: 0, gap, lost: 0 };
  }
  const aliveCount = (id) => { const s = stateOf(id); return s.kind === 'alive' ? s.count : 0; };

  const maxBest = () => Math.max(0, ...Object.values(ST.streaks).map(s => Math.max(s.best || 0, s.count || 0)));
  const restoresTotal = () => BASE_RESTORES + bonusRestores(maxBest());
  const restoresLeft = () => Math.max(0, restoresTotal() - ST.used);

  const unopened = () => ST.snapsIn.filter(s => s.state === 'new' && s.img && (s.views || 0) === 0);
  const unopenedFrom = (uid) => unopened().filter(s => s.from === uid).sort((a, b) => a.t - b.t);
  const replayable = (uid) => {
    const max = maxViews();
    return ST.snapsIn.filter(s => s.from === uid && s.state === 'opened' && s.img && s.views > 0 && s.views < max).sort((a, b) => b.t - a.t)[0] || null;
  };
  const lastOut = (uid) => ST.snapsOut.filter(s => s.to === uid).sort((a, b) => b.t - a.t)[0] || null;
  const ago = (ms) => {
    const m = Math.max(0, Math.round((Date.now() - ms) / 6e4));
    return m < 1 ? 'zojuist' : m < 60 ? m + ' min geleden' : m < 1440 ? Math.round(m / 60) + ' uur geleden' : Math.round(m / 1440) + ' d geleden';
  };

  /* ---------------- luisteraars ---------------- */
  function start() {
    stop();
    const uid = myUid(); if (!uid) return;
    ST.unsub.push(X.watch('streaks', query(collection(db, 'streaks'), where('users', 'array-contains', uid)), snap => {
      ST.streaks = {}; snap.forEach(d => { ST.streaks[d.id] = d.data(); });
      settle(); changed();
    }));
    ST.unsub.push(X.watch('streakr', query(collection(db, 'snaps'), where('to', '==', uid)), snap => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) })).map(s => ({ ...s, t: s.createdAt?.toMillis?.() || Date.now(), o: s.openedAt?.toMillis?.() || 0 }));
      if (!ST.firstIn) {
        for (const ch of snap.docChanges()) {
          if (ch.type !== 'added' || ch.doc.metadata.hasPendingWrites) continue;
          const s = ch.doc.data(); if (s.state !== 'new') continue;
          loadNames([s.from]);
          X.notify('dm', s.name || 'Streakr', 'heeft een streakr gestuurd', () => X.setTab('streakr'), 'streakr');
        }
      }
      ST.firstIn = false;
      ST.snapsIn = list; cleanup(); changed();
    }));
    ST.unsub.push(X.watch('streakr-out', query(collection(db, 'snaps'), where('from', '==', uid)), snap => {
      ST.snapsOut = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) })).map(s => ({ ...s, t: s.createdAt?.toMillis?.() || Date.now(), o: s.openedAt?.toMillis?.() || 0 }));
      cleanup(); changed();
    }));
    ST.unsub.push(onSnapshot(doc(db, 'config', 'streakr'), s => {
      ST.cfg = { storage: s.exists() && ['cloudinary', 'firestore'].includes(s.data().storage) ? s.data().storage : '' };
      ST.cfgSubs.forEach(fn => { try { fn(); } catch {} });
    }, () => {}));
    ST.unsub.push(onSnapshot(doc(db, 'streakUsers', uid), s => { ST.used = s.exists() ? (s.data().used || 0) : 0; changed(); }, () => {}));
    ST.late = hoursLeft() <= SAND_H;
    ST.tick = setInterval(() => { if (S.chat?.type === 'dm') decorateChat(); cleanup(); const late = hoursLeft() <= SAND_H; if (late !== ST.late) { ST.late = late; changed(); } }, 60000);   // 24 uur voorbij? dan verdwijnt het blokje
    ST.ready = true;
    loadTop().then(changed);
  }
  function stop() {
    clearInterval(ST.tick);
    ST.unsub.forEach(u => { try { u(); } catch {} });
    Object.assign(ST, { streaks: {}, snapsIn: [], snapsOut: [], used: 0, ready: false, cfg: { storage: '' }, unsub: [], firstIn: true, top: { list: [], at: 0, busy: null } });
    ST.settling.clear(); ST.busy.clear();
    document.querySelectorAll('.stk-cam, .stk-view').forEach(e => e.remove());
    paintBadge();
  }
  const loadNames = (uids) => X.loadProfiles(uids);

  function changed() {
    cancelAnimationFrame(ST.raf);
    ST.raf = requestAnimationFrame(() => {
      paintBadge();
      if (S.tab === 'streakr') fill();
      if (S.chat?.type === 'dm') decorateChat();
      X.scheduleSidebar();
    });
  }
  function paintBadge() {
    const b = $('#stkBadge'); if (!b) return;
    const n = unopened().length;
    b.hidden = !n; b.textContent = n > 9 ? '9+' : String(n);
  }

  // een streak die een dag is gemist wordt "afgelopen": count -> lost (zodat hij herstelbaar is en uit de top 10 verdwijnt)
  function settle() {
    const t = todayNum();
    for (const [id, d] of Object.entries(ST.streaks)) {
      if (!(d.count >= 2) || !d.day || t - dayNum(d.day) <= 1 || ST.settling.has(id)) continue;
      ST.settling.add(id);
      updateDoc(doc(db, 'streaks', id), { count: 0, lost: d.count, updatedAt: serverTimestamp() }).catch(() => {});
    }
  }
  // opruimen: bekeken streakrs zonder kijkbeurten over wissen hun foto; heel oude weg
  function cleanup() {
    if (!S.profile) return;       // tier nog niet bekend: nog niets wissen (Plus mag 3x kijken)
    const max = maxViews(), now = Date.now();
    for (const s of ST.snapsIn) {
      if (ST.busy.has(s.id)) continue;
      if (now - s.t > SNAP_TTL || (s.state === 'gone' && now - (s.o || s.t) > 2 * 864e5)) { ST.busy.add(s.id); deleteDoc(doc(db, 'snaps', s.id)).catch(() => {}); }
      else if (s.img && s.views >= max) { ST.busy.add(s.id); updateDoc(doc(db, 'snaps', s.id), { img: '', state: 'gone' }).catch(() => {}); }
    }
    for (const s of ST.snapsOut) {
      if (ST.busy.has(s.id)) continue;
      if (now - s.t > SNAP_TTL || (s.state === 'gone' && now - (s.o || s.t) > 2 * 864e5)) { ST.busy.add(s.id); deleteDoc(doc(db, 'snaps', s.id)).catch(() => {}); }
    }
  }

  /* ---------------- top 10 ---------------- */
  async function loadTop(force) {
    if (!S.me) return [];
    if (!force && ST.top.at && Date.now() - ST.top.at < 120000) return ST.top.list;
    if (ST.top.busy) return ST.top.busy;
    ST.top.busy = (async () => {
      try {
        const snap = await getDocs(query(collection(db, 'streaks'), orderBy('count', 'desc'), limit(40)));
        const t = todayNum();
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .filter(s => s.count > 0 && s.day && t - dayNum(s.day) <= 1 && Array.isArray(s.users))
          .sort((a, b) => b.count - a.count || (b.best || 0) - (a.best || 0) || a.id.localeCompare(b.id)).slice(0, 10);
        ST.top.list = list; ST.top.at = Date.now();
        loadNames(list.flatMap(s => s.users));
      } catch (e) { console.warn('Streakr top 10:', e); ST.top.at = Date.now() - 90000; }
      finally { ST.top.busy = null; }
      return ST.top.list;
    })();
    return ST.top.busy;
  }
  function rankOf(uid) {
    const i = ST.top.list.findIndex(s => s.users.includes(uid));
    return i < 0 ? null : { rank: i + 1, entry: ST.top.list[i] };
  }
  const nameIn = (e, uid) => X.PROF[uid]?.username || e.names?.[uid] || 'Onbekend';
  // badge voor op het profiel: "Streakr #5" als je (met iemand) op plek 5 van de top 10 staat
  function badge(uid) {
    const r = rankOf(uid); if (!r) return null;
    const other = r.entry.users.find(u => u !== uid);
    return h('span', { class: 'badge stk-badge', style: '--c:#ff7a2f', title: `Plek ${r.rank} in de Streakr top 10: ${r.entry.count} dagen met ${nameIn(r.entry, other)}` },
      h('span', { class: 'bd-ic' }, h('img', { src: FLAME, alt: '' })), h('b', { text: 'Streakr' }), h('small', { text: '#' + r.rank }));
  }

  /* ---------------- streak bijwerken bij versturen ---------------- */
  async function registerSend(f) {
    const me = myUid(), other = X.otherId(f), today = dayStr(), ref = doc(db, 'streaks', f.id);
    await runTransaction(db, async (tx) => {
      const s = await tx.get(ref);
      const d = s.exists() ? { ...s.data() } : { users: [...f.users].sort(), names: { [me]: S.profile?.username || 'Onbekend', [other]: X.otherName(f) }, count: 0, day: '', sent: {}, lost: 0, best: 0 };
      d.sent = { ...(d.sent || {}), [me]: today };
      if (d.sent[other] === today && d.day !== today) {      // jullie hebben allebei vandaag gestuurd
        const gap = d.day ? todayNum() - dayNum(d.day) : 99;
        if (d.count > 0 && gap <= 1) d.count += 1;
        else { if (d.count >= 2) d.lost = d.count; d.count = 1; }   // nieuwe streak (de oude blijft herstelbaar)
        d.day = today; d.best = Math.max(d.best || 0, d.count); d.incAt = serverTimestamp();
      }
      d.updatedAt = serverTimestamp();
      if (s.exists()) tx.update(ref, d); else tx.set(ref, d);
    });
  }

  /* ---------------- herstellen (Infinitum Prime) ---------------- */
  function restore(f) {
    const st = stateOf(f.id), name = X.otherName(f);
    if (!(st.lost > 0)) return;
    if (!X.tierAtLeast('prime')) { X.askUpgrade('prime', 'Streaks herstellen'); return; }
    if (!restoresLeft()) {
      X.toast(`Je hebt geen herstellers meer. Bij 100, 300, 500, 700… dagen streak krijg je er een bij.`);
      return;
    }
    const go = h('button', { class: 'glow', type: 'button', text: 'Herstellen' });
    go.onclick = async () => {
      go.disabled = true; go.textContent = 'Bezig…';
      try {
        const ref = doc(db, 'streaks', f.id);
        let d = ST.streaks[f.id] || {};
        const gap = d.day ? todayNum() - dayNum(d.day) : 99;
        if (d.count >= 2 && gap > 1) {                       // nog niet afgesloten: eerst de afgelopen streak bewaren
          await updateDoc(ref, { count: 0, lost: d.count, updatedAt: serverTimestamp() });
          d = { ...d, count: 0, lost: d.count };
        }
        const lost = d.lost || 0, cnt = d.count || 0;
        if (!(lost > 0)) throw new Error('Er is niets om te herstellen.');
        const newCount = cnt + lost;
        const patch = { count: newCount, lost: 0, best: Math.max(d.best || 0, newCount), updatedAt: serverTimestamp() };
        if (!(cnt > 0)) patch.day = dayStr(Date.now() - 864e5);      // alsof gisteren de laatste dag was: vandaag weer allebei sturen
        const b = writeBatch(db);
        b.update(ref, patch);
        b.set(doc(db, 'streakUsers', myUid()), { used: ST.used + 1 });
        await b.commit();
        X.closeDialog(); X.toast(`Streak van ${lost} dagen met ${name} is hersteld! Stuur vandaag allebei een streakr om hem te houden.`);
      } catch (e) { X.closeDialog(); X.toast(e?.code ? X.fbErr(e) : (e?.message || 'Herstellen mislukt.')); }
    };
    X.openDialog(
      h('h3', { text: 'Streak herstellen?' }),
      h('p', { class: 'sub', text: `Je streak van ${st.lost} dagen met ${name} komt terug. Dit kost 1 hersteller; je hebt er nu ${restoresLeft()} van ${restoresTotal()}.` }),
      h('p', { class: 'hint', text: 'Je krijgt er een hersteller bij als je een streak van 100, 300, 500, 700… dagen haalt.' }),
      h('div', { class: 'dlg-actions' }, h('button', { class: 'ghost', type: 'button', onclick: X.closeDialog, text: 'Annuleren' }), go));
  }

  /* ---------------- streakr bekijken ---------------- */
  function imgSrc(s) {
    if (s.src === 'data') return IMG_RE.test(s.img || '') ? s.img : '';
    const u = X.safeMedia(s.img); if (!u) return '';
    return X.CLD_BASE && u.startsWith(X.CLD_BASE) ? X.CLD_BASE + 'c_limit,w_1280,q_auto:good,f_jpg/' + u.slice(X.CLD_BASE.length) : u;
  }
  async function openSnap(s) {
    if (document.querySelector('.stk-view') || document.querySelector('.stk-cam')) return;
    const max = maxViews();
    if (!s.img || s.views >= max) { X.toast('Dit streakr kun je niet meer bekijken.'); return; }
    const src = imgSrc(s);
    if (!src) { X.toast('Dit streakr kan niet worden getoond.'); return; }
    const views = (s.views || 0) + 1;
    const pre = new Image(); pre.src = src;
    try {
      await Promise.all([
        updateDoc(doc(db, 'snaps', s.id), views === 1 ? { views, state: 'opened', openedAt: serverTimestamp() } : { views, state: 'opened' }),      // eerst tellen, dan tonen: sluit je de app halverwege, dan telt het toch
        pre.decode().catch(() => {})
      ]);
    } catch (e) { X.toast(X.fbErr(e)); return; }
    s.views = views; s.state = 'opened'; if (!s.o) s.o = Date.now();
    const secs = Math.min(10, Math.max(1, Math.round(+s.secs) || 5));
    const left = max - views;
    const fr = X.accepted().find(f => f.id === s.pair || X.otherId(f) === s.from);
    const img = h('img', { class: 'stk-view-img', src, alt: 'Streakr', draggable: 'false' });
    const bar = h('i', { class: 'stk-bar', style: `animation-duration:${secs}s` });
    const root = h('div', { class: 'stk-view', role: 'dialog', 'aria-label': 'Streakr' },
      img,
      h('div', { class: 'stk-view-top' },
        h('div', { class: 'stk-timer' }, bar),
        h('div', { class: 'stk-view-who' }, X.avatar(s.from, s.name, 34, true, true), h('b', { text: s.name || 'Streakr' }),
          h('small', { text: left > 0 ? `nog ${left}x te bekijken` : 'laatste keer' }),
          h('button', { class: 'stk-cbtn', type: 'button', html: IC.x, 'aria-label': 'Sluiten', onclick: () => end() }))),
      fr ? replyBar() : h('p', { class: 'stk-view-hint', text: 'Tik om te sluiten' }));
    let done = false, timer = 0;
    // reageren: een berichtje terug in de chat, of meteen een streakr terugsturen met de camera
    function replyBar() {
      const inp = h('input', { class: 'stk-reply-in', type: 'text', maxlength: 500, placeholder: 'Reageer…', enterkeyhint: 'send', autocomplete: 'off' });
      const send = h('button', { class: 'stk-cbtn', type: 'button', html: IC.send, 'aria-label': 'Versturen', hidden: true });
      const cam = h('button', { class: 'stk-cbtn cam', type: 'button', html: IC.cam, title: 'Streakr terugsturen', 'aria-label': 'Streakr terugsturen' });
      const bar = h('div', { class: 'stk-reply' }, inp, send, cam);
      const go = async () => {
        const text = inp.value.trim(); if (!text) return;
        inp.disabled = true; send.disabled = true;
        try { await X.sendDm(fr.id, text, { id: s.id, uid: s.from, name: s.name || 'Streakr', text: 'Streakr', snap: true }); X.toast('Reactie verstuurd.'); end(); }
        catch (e) { inp.disabled = false; send.disabled = false; X.toast(e?.code ? X.fbErr(e) : (e?.message || 'Versturen mislukt.')); }
      };
      inp.addEventListener('input', () => { send.hidden = !inp.value.trim(); cam.hidden = !!inp.value.trim(); });
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); go(); } else if (e.key === 'Escape') end(); });
      inp.addEventListener('focus', () => { clearTimeout(timer); bar.classList.add('typing'); root.classList.add('paused'); });   // tijdens het typen blijft de foto staan
      send.addEventListener('click', go);
      cam.addEventListener('click', () => { const uid = s.from; end(); openCamera(uid); });
      bar.addEventListener('click', (e) => e.stopPropagation());
      return bar;
    }
    const end = () => {
      if (done) return; done = true; clearTimeout(timer);
      document.removeEventListener('keydown', onKey); document.removeEventListener('visibilitychange', onVis);
      vv?.removeEventListener('resize', fit);
      root.remove();
      if (views >= max) { ST.busy.add(s.id); updateDoc(doc(db, 'snaps', s.id), { img: '', state: 'gone' }).catch(() => {}); }
      changed();
    };
    const onKey = (e) => { if (e.key === 'Escape') end(); };
    const onVis = () => { if (document.hidden) end(); };
    root.addEventListener('click', end);
    root.addEventListener('contextmenu', e => e.preventDefault());
    const vv = window.visualViewport;
    const fit = () => { if (vv) root.style.height = vv.height + 'px'; };
    if (vv) { vv.addEventListener('resize', fit); fit(); }
    document.addEventListener('keydown', onKey); document.addEventListener('visibilitychange', onVis);
    document.body.append(root);
    timer = setTimeout(end, secs * 1000);
  }

  /* ---------------- foto-bewerking: alleen een bijschrift (klein, versleepbaar) ---------------- */
  function drawCaption(g, w, hh, text, pos) {
    text = String(text || '').trim(); if (!text) return;
    const fs = Math.max(11, Math.round(w * .036));
    g.font = `600 ${fs}px Outfit, system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    const lines = []; let cur = '';
    for (const word of text.split(/\s+/)) {
      const test = cur ? cur + ' ' + word : word;
      if (g.measureText(test).width > w * .8 && cur) { lines.push(cur); cur = word; } else cur = test;
    }
    if (cur) lines.push(cur);
    const shown = lines.slice(0, 4), lh = fs * 1.28;
    const tw = Math.max(...shown.map(l => g.measureText(l).width)), bw = Math.min(w, tw + fs * 1.1), bh = shown.length * lh + fs * .6;
    const cx = Math.min(w - bw / 2, Math.max(bw / 2, (pos?.x ?? .5) * w)), cy = Math.min(hh - bh / 2, Math.max(bh / 2, (pos?.y ?? .7) * hh));
    g.fillStyle = 'rgba(0,0,0,.55)';
    if (g.roundRect) { g.beginPath(); g.roundRect(cx - bw / 2, cy - bh / 2, bw, bh, fs * .45); g.fill(); } else g.fillRect(cx - bw / 2, cy - bh / 2, bw, bh);
    g.fillStyle = '#fff';
    shown.forEach((l, i) => g.fillText(l, cx, cy - bh / 2 + fs * .3 + lh * (i + .5)));
  }
  function compose(base, cap, pos, maxSide) {
    const sc = maxSide ? Math.min(1, maxSide / Math.max(base.width, base.height)) : 1;
    const w = Math.max(1, Math.round(base.width * sc)), hh = Math.max(1, Math.round(base.height * sc));
    const c = document.createElement('canvas'); c.width = w; c.height = hh;
    const g = c.getContext('2d');
    g.drawImage(base, 0, 0, w, hh); drawCaption(g, w, hh, cap, pos);
    return c;
  }
  const toBlob = (c, q) => new Promise(r => c.toBlob(r, 'image/jpeg', q));
  const toDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Foto lezen mislukt.')); r.readAsDataURL(blob); });

  // Cloudinary: goede kwaliteit (max. 1280 px, JPEG 85%). Firestore: bewust klein en laag (max. 640 px, JPEG ~45%) zodat hij in een document past.
  async function exportImage(base, cap, pos, viaCloud) {
    let { q, side } = viaCloud ? Q_CLOUD : Q_FIRE;
    for (let i = 0; i < 6; i++) {
      const c = compose(base, cap, pos, side);
      const blob = await toBlob(c, q);
      if (!blob) throw new Error('Foto maken mislukt.');
      if (viaCloud) return { blob, w: c.width, h: c.height };
      const url = await toDataUrl(blob);
      if (url.length <= MAX_DATA) return { url, w: c.width, h: c.height };
      q = Math.max(.25, q - .06); side = Math.round(side * .86);
    }
    throw new Error('Deze foto is te groot om te versturen.');
  }

  /* ---------------- camera + versturen ---------------- */
  function openCamera(preUid) {
    if (!S.me) return;
    const lock = X.modStatus(); if (lock) { X.toast(X.modLockText(lock)); return; }
    const friends = X.accepted();
    if (!friends.length) { X.toast('Je hebt nog geen vrienden om een streakr naar te sturen.'); return; }
    if (document.querySelector('.stk-cam') || document.querySelector('.stk-view')) return;
    const root = h('div', { class: 'stk-cam', role: 'dialog', 'aria-label': 'Streakr maken' });
    document.body.append(root);
    let stream = null, facing = 'environment', base = null, secs = 5, cap = '', capPos = { x: .5, y: .7 }, alive = true, sending = false;   // standaard de achtercamera
    const picked = new Set(preUid ? [preUid] : []);
    const stopStream = () => { stream?.getTracks().forEach(t => t.stop()); stream = null; };
    const close = () => { alive = false; stopStream(); document.removeEventListener('keydown', onKey); document.removeEventListener('paste', onPaste); root.remove(); };
    const onKey = (e) => { if (e.key === 'Escape' && !sending) close(); };
    document.addEventListener('keydown', onKey);
    // pc: plak een screenshot (Ctrl+V) of sleep een afbeelding erin
    const onPaste = (e) => { if (base) return; const it = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/')); const f = it?.getAsFile(); if (f) { e.preventDefault(); fromFile(f); } };
    if (!X.isMobile) { document.addEventListener('paste', onPaste); root.addEventListener('dragover', e => e.preventDefault()); root.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f && !base) fromFile(f); }); }
    const topBar = (title, onBack) => h('div', { class: 'stk-cam-top' },
      h('button', { class: 'stk-cbtn', type: 'button', html: onBack ? IC.back : IC.x, 'aria-label': onBack ? 'Terug' : 'Sluiten', onclick: onBack || close }),
      h('b', { text: title }), h('span', { class: 'stk-cspace' }));

    async function fromFile(file) {
      if (!/^image\//.test(file.type || '')) { X.toast('Kies een afbeelding.'); return; }
      let bmp; try { bmp = await createImageBitmap(file); } catch { X.toast('Dit bestand kan ik niet als afbeelding lezen.'); return; }
      const sc = Math.min(1, BASE_MAX / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * sc)); c.height = Math.max(1, Math.round(bmp.height * sc));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
      base = c; stepEdit();
    }

    /* stap 1: camera */
    function stepScreen() {
      stopStream(); base = null;
      const msg = h('p', { text: 'Plak een screenshot met Ctrl+V, sleep een afbeelding hierheen, of leg je scherm vast.' });
      const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
      file.addEventListener('change', () => { const f = file.files[0]; if (f) fromFile(f); });
      const grab = h('button', { class: 'glow', type: 'button', text: 'Scherm vastleggen' });
      grab.onclick = async () => {
        if (!navigator.mediaDevices?.getDisplayMedia) { msg.textContent = 'Je browser kan het scherm niet vastleggen. Plak een screenshot met Ctrl+V of kies een bestand.'; return; }
        try {
          const st = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
          const v = document.createElement('video'); v.muted = true; v.srcObject = st; await v.play();
          await new Promise(r => setTimeout(r, 400));
          const vw = v.videoWidth, vh = v.videoHeight, sc = Math.min(1, BASE_MAX / Math.max(vw, vh));
          const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(vw * sc)); c.height = Math.max(1, Math.round(vh * sc));
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          st.getTracks().forEach(t => t.stop());
          base = c; stepEdit();
        } catch { msg.textContent = 'Scherm vastleggen is geannuleerd of geweigerd. Plak een screenshot met Ctrl+V of kies een bestand.'; }
      };
      root.replaceChildren(topBar('Streakr'),
        h('div', { class: 'stk-desk' }, h('div', { class: 'stk-drop' }, h('h3', { text: 'Screenshot sturen' }), msg,
          h('div', { class: 'stk-drop-btns' }, grab, h('button', { class: 'ghost', type: 'button', text: 'Afbeelding kiezen', onclick: () => file.click() })))), file);
    }
    function stepCamera() {
      if (!X.isMobile) { stepScreen(); return; }
      stopStream(); base = null;
      const video = h('video', { class: 'stk-video', autoplay: true, playsinline: true });
      video.muted = true;
      const msg = h('p', { class: 'stk-cam-msg' });
      const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
      file.addEventListener('change', () => { const f = file.files[0]; if (f) fromFile(f); });
      const shutter = h('button', { class: 'stk-shutter', type: 'button', 'aria-label': 'Foto maken' });
      const flip = h('button', { class: 'stk-cbtn lg', type: 'button', html: IC.flip, title: 'Camera wisselen', 'aria-label': 'Camera wisselen' });
      const gal = h('button', { class: 'stk-cbtn lg', type: 'button', html: IC.img, title: 'Foto kiezen', 'aria-label': 'Foto kiezen', onclick: () => file.click() });
      // v0.14: inzoomen. Knijpen met twee vingers of de schuif. Heeft de camera echte (optische) zoom, dan gebruiken we die; anders digitaal.
      let zoom = 1, zMin = 1, zMax = 5, hw = false;
      const zlabel = h('span', { class: 'stk-zlabel', text: '1×' });
      const zslide = h('input', { class: 'stk-zslide', type: 'range', min: 1, max: 5, step: 0.05, value: 1, 'aria-label': 'Zoom' });
      const zbox = h('div', { class: 'stk-zoom' }, zlabel, zslide);
      const stage = h('div', { class: 'stk-stage' }, video, zbox);
      const setZoom = (z) => {
        zoom = Math.min(zMax, Math.max(zMin, z)); zslide.value = zoom;
        zlabel.textContent = (Math.round(zoom * 10) / 10) + '×';
        if (hw) stream?.getVideoTracks()[0]?.applyConstraints({ advanced: [{ zoom }] }).catch(() => {});
        else video.style.setProperty('--z', zoom);
      };
      zslide.addEventListener('input', () => setZoom(+zslide.value));
      const ptrs = new Map(); let p0 = null;
      stage.addEventListener('pointerdown', (e) => { if (e.target === zslide) return; ptrs.set(e.pointerId, [e.clientX, e.clientY]); p0 = null; });
      stage.addEventListener('pointermove', (e) => {
        if (!ptrs.has(e.pointerId)) return;
        ptrs.set(e.pointerId, [e.clientX, e.clientY]);
        if (ptrs.size !== 2) return;
        const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (!p0) p0 = { d, z: zoom }; else setZoom(p0.z * d / p0.d);
      });
      const pend = (e) => { ptrs.delete(e.pointerId); p0 = null; };
      stage.addEventListener('pointerup', pend); stage.addEventListener('pointercancel', pend); stage.addEventListener('pointerleave', pend);
      stage.addEventListener('dblclick', () => setZoom(zoom > zMin + 0.05 ? zMin : Math.min(zMax, Math.max(2, zMin * 2))));
      const noCam = (t) => { msg.textContent = t; shutter.disabled = true; flip.disabled = true; zbox.hidden = true; video.hidden = true; };
      const startCam = async () => {
        if (!navigator.mediaDevices?.getUserMedia) { noCam('Je browser laat geen camera toe. Kies een foto uit je galerij.'); return; }
        try {
          stopStream();
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
          if (!alive) { stopStream(); return; }
          video.srcObject = stream; video.classList.toggle('mirror', facing === 'user');
          const zc = stream.getVideoTracks()[0]?.getCapabilities?.()?.zoom;   // echte camerazoom (vooral Android)
          hw = !!(zc && zc.max > zc.min);
          zMin = hw ? zc.min : 1; zMax = hw ? Math.min(zc.max, 10) : 5;
          zslide.min = zMin; zslide.max = zMax; zslide.step = hw && zc.step ? zc.step : 0.05;
          video.style.setProperty('--z', 1); zbox.hidden = false;
          setZoom(Math.max(zMin, 1));
          await video.play().catch(() => {}); msg.textContent = '';
        } catch { noCam('Geen toegang tot de camera. Geef toestemming in je browser, of kies een foto uit je galerij.'); }
      };
      flip.onclick = () => { facing = facing === 'user' ? 'environment' : 'user'; startCam(); };
      shutter.onclick = () => {
        const vw = video.videoWidth, vh = video.videoHeight; if (!vw || !vh) return;
        // digitale zoom: alleen het midden van het beeld bewaren (bij echte camerazoom is het beeld al ingezoomd)
        const dz = hw ? 1 : Math.max(1, zoom), cw = vw / dz, ch = vh / dz, sx = (vw - cw) / 2, sy = (vh - ch) / 2;
        const sc = Math.min(1, BASE_MAX / Math.max(cw, ch));
        const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(cw * sc)); c.height = Math.max(1, Math.round(ch * sc));
        const g = c.getContext('2d');
        if (facing === 'user') { g.translate(c.width, 0); g.scale(-1, 1); }
        g.drawImage(video, sx, sy, cw, ch, 0, 0, c.width, c.height);
        stopStream(); base = c; stepEdit();
      };
      root.replaceChildren(topBar('Streakr'), stage, msg, h('div', { class: 'stk-cam-bottom' }, gal, shutter, flip), file);
      startCam();
    }

    /* stap 2: bijschrift (versleepbaar) en tijd */
    function stepEdit() {
      stopStream();
      const view = h('canvas', { class: 'stk-edit-cv' });
      let raf = 0;
      const paint = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { const c = compose(base, cap, capPos, 640); view.width = c.width; view.height = c.height; view.getContext('2d').drawImage(c, 0, 0); }); };
      // het bijschrift verslepen: de beweging van je vinger/muis verplaatst het blokje
      let drag = null;
      view.addEventListener('pointerdown', (e) => {
        if (!cap.trim()) return;
        const r = view.getBoundingClientRect(), k = Math.min(r.width / view.width, r.height / view.height);
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY, p: { ...capPos }, dw: view.width * k, dh: view.height * k };
        view.setPointerCapture?.(e.pointerId); e.preventDefault();
      });
      view.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        capPos = { x: Math.min(.95, Math.max(.05, drag.p.x + (e.clientX - drag.x) / drag.dw)), y: Math.min(.97, Math.max(.03, drag.p.y + (e.clientY - drag.y) / drag.dh)) };
        paint();
      });
      const drop = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
      view.addEventListener('pointerup', drop); view.addEventListener('pointercancel', drop);
      const capIn = h('input', { class: 'inp stk-cap', maxlength: 80, placeholder: 'Bijschrift (optioneel) — sleep het op de foto', value: cap });
      capIn.addEventListener('input', () => { cap = capIn.value; paint(); });
      const secBtns = [3, 5, 10].map(n => h('button', { class: 'stk-sec' + (n === secs ? ' on' : ''), type: 'button', 'data-n': n, text: n + ' s', onclick: () => { secs = n; secBtns.forEach(b => b.classList.toggle('on', +b.dataset.n === n)); } }));
      root.replaceChildren(
        topBar('Bewerken', stepCamera),
        h('div', { class: 'stk-edit' }, view),
        h('div', { class: 'stk-edit-tools' },
          capIn,
          h('div', { class: 'stk-secs' }, h('small', { text: 'Zichtbaar voor' }), secBtns)),
        h('div', { class: 'stk-cam-foot' }, h('button', { class: 'glow wide', type: 'button', onclick: stepSend }, 'Verder')));
      paint();
    }

    /* stap 3: kies vrienden en verstuur */
    function stepSend() {
      const list = h('div', { class: 'stk-pick' });
      const btn = h('button', { class: 'glow wide', type: 'button' });
      const err = h('p', { class: 'err' });
      const refresh = () => { btn.disabled = sending || !picked.size; btn.textContent = sending ? 'Versturen…' : picked.size ? `Versturen naar ${picked.size} ${picked.size === 1 ? 'vriend' : 'vrienden'}` : 'Kies een vriend'; };
      const sorted = [...friends].sort((a, b) => aliveCount(b.id) - aliveCount(a.id) || X.otherName(a).localeCompare(X.otherName(b)));
      for (const f of sorted) {
        const uid = X.otherId(f), c = aliveCount(f.id);
        const cb = h('input', { type: 'checkbox' }); cb.checked = picked.has(uid);
        const row = h('label', { class: 'stk-pickrow' },
          X.avatar(uid, X.otherName(f), 40, true, true),
          h('span', { class: 'item-text' }, h('b', { text: X.otherName(f) }), c ? h('small', { text: `${c} dagen streak` }) : h('small', { text: 'Nog geen streak' })),
          c ? h('span', { class: 'stk-count sm' }, String(c), h('img', { src: FLAME, alt: '' })) : null, cb);
        cb.addEventListener('change', () => { cb.checked ? picked.add(uid) : picked.delete(uid); refresh(); });
        list.append(row);
      }
      btn.onclick = async () => {
        if (sending || !picked.size) return;
        sending = true; err.textContent = ''; refresh();
        try {
          const n = await sendSnaps([...picked].map(u => friends.find(f => X.otherId(f) === u)).filter(Boolean));
          close(); X.toast(n === 1 ? 'Streakr verstuurd!' : `Streakr verstuurd naar ${n} vrienden!`);
        } catch (e) { sending = false; err.textContent = e.message || X.fbErr(e); refresh(); }
      };
      refresh();
      root.replaceChildren(topBar('Versturen naar', stepEdit),
        h('div', { class: 'stk-send' }, list),
        h('div', { class: 'stk-cam-foot' }, err,
          h('p', { class: 'hint', text: (storageMode() === 'cloudinary' ? 'Je vrienden zien de foto in goede kwaliteit' : 'Je vrienden zien de foto in lagere kwaliteit') + ' en kunnen hem 1x bekijken (Infinitum+ 2x, Prime 3x).' }), btn));
    }

    async function sendSnaps(targets) {
      const viaCloud = storageMode() === 'cloudinary';
      const out = await exportImage(base, cap, capPos, viaCloud);
      let img, src;
      if (viaCloud) { img = await X.uploadMedia(out.blob, 'image/jpeg'); src = 'cld'; } else { img = out.url; src = 'data'; }
      let ok = 0;
      for (const f of targets) {
        const ref = doc(collection(db, 'snaps'));
        const b = writeBatch(db);
        b.set(ref, { from: myUid(), to: X.otherId(f), pair: f.id, name: S.profile?.username || 'Onbekend', createdAt: serverTimestamp(), src, img, w: out.w, h: out.h, secs, views: 0, state: 'new' });
        await b.commit();
        ok++;
        registerSend(f).catch(e => console.warn('Streak bijwerken mislukt:', e));
        X.pushPing({ type: 'streakr', sid: ref.id });
      }
      return ok;
    }

    stepCamera();
  }

  /* ---------------- de Streakr-pagina ---------------- */
  const flameImg = (cls = '') => h('img', { class: 'stk-fl ' + cls, src: FLAME, alt: 'streak' });

  function riskText(st, uid, name) {
    const t = dayStr(), me = myUid(), left = hoursLeft();
    const when = left < 1 ? 'minder dan een uur' : `nog ${Math.floor(left)} uur`;
    if (st.d?.sent?.[me] === t) return `⏳ wacht op ${name} · ${when}`;
    if (st.d?.sent?.[uid] === t) return `⏳ jij bent aan de beurt · ${when}`;
    return `⏳ stuur vandaag een streakr · ${when}`;
  }

  function stateEl(f, st, uid, name) {
    const out = [];
    if (st.kind === 'alive') {
      out.push(h('span', { class: 'stk-count' + (st.count >= 100 ? ' hot' : ''), title: `${st.count} dagen streak` }, String(st.count), flameImg()));
      if (st.gap === 1 && hoursLeft() <= SAND_H) out.push(h('span', { class: 'stk-risk', text: riskText(st, uid, name) }));
      if (st.lost > 0) out.push(h('button', { class: 'stk-restore sm', type: 'button', text: `+${st.lost} herstellen`, onclick: (e) => { e.stopPropagation(); restore(f); } }));
    } else if (st.kind === 'lost') {
      out.push(h('span', { class: 'stk-tag red', text: 'Streak afgelopen!' }));
      out.push(h('button', { class: 'stk-restore', type: 'button', text: 'Herstellen', title: `${st.lost} dagen herstellen`, onclick: (e) => { e.stopPropagation(); restore(f); } }));
    } else out.push(h('span', { class: 'stk-tag dim', text: 'Begin een streak!' }));
    return h('div', { class: 'stk-state' }, out);
  }

  function metaText(uid) {
    const o = lastOut(uid); if (!o) return '';
    return `↗ ${o.state === 'new' ? 'Verzonden' : 'Geopend'} · ${ago(o.t)}`;
  }

  function rowEl(f) {
    const uid = X.otherId(f), name = X.otherName(f), st = stateOf(f.id);
    const ins = unopenedFrom(uid), rep = ins.length ? null : replayable(uid), meta = metaText(uid);
    const acts = h('div', { class: 'stk-acts' });
    if (ins.length) acts.append(h('button', { class: 'stk-open', type: 'button', text: ins.length > 1 ? `Open (${ins.length})` : 'Open', onclick: (e) => { e.stopPropagation(); openSnap(ins[0]); } }));
    else if (rep) acts.append(h('button', { class: 'stk-replay', type: 'button', text: `Opnieuw (${maxViews() - rep.views}x)`, onclick: (e) => { e.stopPropagation(); openSnap(rep); } }));
    acts.append(
      h('button', { class: 'stk-cbtn cam', type: 'button', html: IC.cam, title: 'Streakr sturen', 'aria-label': `Streakr sturen naar ${name}`, onclick: (e) => { e.stopPropagation(); openCamera(uid); } }));
    return h('div', {
      class: 'stk-row' + (ins.length ? ' new' : ''), tabindex: 0,
      onclick: (e) => { if (e.target.closest('.avatar') || !ins.length) return; openSnap(ins[0]); }
    },
      X.dotted(uid, name, 50),
      h('div', { class: 'stk-mid' },
        h('div', { class: 'stk-line' }, h('b', { class: 'stk-name', text: name }), stateEl(f, st, uid, name)),
        meta ? h('small', { class: 'stk-meta', text: meta }) : null),
      acts);
  }

  const rankRank = (f) => { const s = stateOf(f.id); return s.kind === 'alive' ? 3 : s.kind === 'lost' ? 2 : 1; };
  function fill() {
    const list = $('#stkList'); if (!list) return;
    const friends = [...X.accepted()].sort((a, b) =>
      (unopenedFrom(X.otherId(b)).length ? 1 : 0) - (unopenedFrom(X.otherId(a)).length ? 1 : 0)
      || rankRank(b) - rankRank(a) || aliveCount(b.id) - aliveCount(a.id) || X.otherName(a).localeCompare(X.otherName(b)));
    X.loadProfiles(friends.map(X.otherId));
    list.replaceChildren(...(friends.length ? friends.map(rowEl) : [h('p', { class: 'stk-empty' }, 'Je hebt nog geen vrienden. Voeg iemand toe bij ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); X.setTab('friends'); } }, 'Friends'), ' om streaks te starten.')]));
    const tools = $('#stkTools');
    if (tools) {
      const kids = [h('button', { class: 'glow sm', type: 'button', onclick: () => openCamera(), html: IC.cam + 'Nieuwe streakr' })];
      if (X.tierAtLeast('prime')) kids.unshift(h('span', { class: 'stk-restores', title: 'Herstellers: 3 als Prime-lid, +1 bij 100, 300, 500, 700… dagen streak', text: `Herstellers: ${restoresLeft()}` }));
      tools.replaceChildren(...kids);
    }
    fillTop();
  }

  function fillTop() {
    const box = $('#stkTop'); if (!box) return;
    const list = ST.top.list, me = myUid();
    if (!list.length) { box.replaceChildren(h('p', { class: 'stk-empty', text: ST.top.at ? 'Nog niemand in de top 10. Start een streak en sta hier als eerste!' : 'Laden…' })); return; }
    box.replaceChildren(...list.map((e, i) => {
      const [a, b] = e.users, mine = e.users.includes(me);
      return h('div', { class: 'stk-top-card' + (mine ? ' mine' : '') + (i < 3 ? ' p' + (i + 1) : ''), title: `${nameIn(e, a)} & ${nameIn(e, b)}: ${e.count} dagen` },
        h('span', { class: 'stk-rank', text: String(i + 1) }),
        h('span', { class: 'stk-pair' }, X.avatar(a, nameIn(e, a), 38, true, true), X.avatar(b, nameIn(e, b), 38, true, true)),
        h('span', { class: 'stk-top-names' }, h('b', { text: nameIn(e, a) }), h('b', { text: nameIn(e, b) })),
        h('span', { class: 'stk-count sm' + (e.count >= 100 ? ' hot' : '') }, String(e.count), flameImg()));
    }));
  }

  function render() {
    $('#main').replaceChildren(h('div', { class: 'stk' },
      h('div', { class: 'stk-scroll' }, h('div', { class: 'stk-wrap' },
        h('div', { class: 'stk-head' }, flameImg('big'), h('h2', { class: 'stk-logo', text: 'STREAKR' }), h('div', { class: 'stk-tools', id: 'stkTools' })),
        h('p', { class: 'stk-sub', text: 'Stuur elke dag allebei minstens één streakr om je streak te houden. Op de pc stuur je screenshots, op je telefoon foto’s. Je kunt ze 1x bekijken (Infinitum+ 2x, Prime 3x).' }),
        h('h3', { class: 'stk-h top', text: 'Top 10' }),
        h('div', { id: 'stkTop', class: 'stk-topstrip' }),
        h('h3', { class: 'stk-h', text: 'Jouw streaks' }),
        h('div', { id: 'stkList', class: 'stk-list' })))));
    fill();
    loadTop().then(() => { if (S.tab === 'streakr') fillTop(); });
  }

  /* ---------------- streakrs als blokje in de chat (zoals Snapchat) ---------------- */
  function decorateChat() {
    const list = $('#msgList'), c = S.chat;
    if (!list || !c || c.type !== 'dm') return;
    list.querySelectorAll('.stk-msg').forEach(e => e.remove());
    const info = X.dmInfo(c.id); if (!info) return;
    const uid = info.uid, now = Date.now(), max = maxViews(), items = [];
    for (const s of ST.snapsIn) {
      if (s.from !== uid) continue;
      const fresh = s.state === 'new' && s.img && !(s.views > 0);
      if (!fresh && !(s.o && now - s.o < CHAT_TTL)) continue;        // geopend: 24 uur na openen weg
      items.push({ s, mine: false, fresh, again: !fresh && s.img && s.views > 0 && s.views < max });
    }
    for (const s of ST.snapsOut) {
      if (s.to !== uid) continue;
      const opened = !!s.o || s.state !== 'new';
      if (opened ? !(s.o && now - s.o < CHAT_TTL) : now - s.t > 3 * 864e5) continue;
      items.push({ s, mine: true, opened });
    }
    if (!items.length) return;
    items.sort((a, b) => a.s.t - b.s.t);
    const msgs = [...list.querySelectorAll('.msg[data-ts]:not(.stk-msg)')];
    for (const it of items) {
      const { s } = it;
      let label, sub, cls = 'stk-chat';
      if (!it.mine) {
        if (it.fresh) { label = 'Streakr'; sub = 'Tik om te openen'; cls += ' new'; }
        else if (it.again) { label = 'Streakr geopend'; sub = `Opnieuw kijken (${maxViews() - s.views}x)`; cls += ' again'; }
        else { label = 'Streakr geopend'; sub = ago(s.o); cls += ' done'; }
      } else { label = it.opened ? 'Streakr geopend' : 'Streakr verzonden'; sub = ago(it.opened && s.o ? s.o : s.t); cls += it.opened ? ' done' : ' sent'; }
      const btn = h('button', { class: cls, type: 'button', disabled: it.mine || !(it.fresh || it.again) },
        h('img', { src: FLAME, alt: '' }), h('span', { class: 'stk-chat-t' }, h('b', { text: label }), h('small', { text: sub })));
      if (!it.mine && (it.fresh || it.again)) btn.onclick = () => openSnap(s);
      const el = h('div', { class: 'msg stk-msg ' + (it.mine ? 'mine' : 'theirs'), 'data-ts': s.t, 'data-sid': s.id }, h('div', { class: 'msg-body' }, h('div', { class: 'bwrap' }, btn)));
      const next = msgs.find(m => +m.dataset.ts > s.t);
      next ? list.insertBefore(el, next) : list.append(el);
    }
    if (c.stick !== false && list.scrollHeight - list.scrollTop - list.clientHeight < 200) list.scrollTop = list.scrollHeight;
  }

  // klik op "Gereageerd op streakr" in een bericht: ga naar het streakr-blokje in de chat (dat blijft 24 uur na openen staan)
  function jumpToSnap(id) {
    const el = document.querySelector(`#msgList .stk-msg[data-sid="${CSS.escape(String(id))}"]`);
    if (!el) { X.toast('Die streakr staat er niet meer. Streakrs verdwijnen 24 uur na het openen.'); return; }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }

  /* ---------------- admin: waar gaan streakr-foto's heen? ---------------- */
  function buildAdmin() {
    const box = h('div', { class: 'acc-form stk-adm' });
    const note = h('p', { class: 'acc-note' });
    let saving = false;
    const OPTS = [
      ['cloudinary', 'Cloudinary: goede kwaliteit', 'Foto’s tot 1280 px en scherp. Het bestand staat bij Cloudinary; in Firestore staat alleen het adres.'],
      ['firestore', 'Firestore: lage kwaliteit', 'Foto’s tot 640 px en sterk verkleind (ongeveer 150 kB), rechtstreeks in Firestore. Cloudinary is dan niet nodig.']
    ];
    const paint = () => {
      if (!box.isConnected && box.dataset.mounted) { ST.cfgSubs.delete(paint); return; }
      box.dataset.mounted = '1';
      const now = storageMode();
      const rows = OPTS.map(([val, title, desc]) => {
        const off = val === 'cloudinary' && !X.cloudOn;
        const rb = h('input', { type: 'radio', name: 'stkStorage', value: val });
        rb.checked = now === val; rb.disabled = saving || off;
        rb.addEventListener('change', async () => {
          if (!rb.checked || saving) return;
          saving = true; paint();
          try {
            await setDoc(doc(db, 'config', 'streakr'), { storage: val, updatedAt: serverTimestamp(), by: myUid() });
            X.toast(val === 'cloudinary' ? 'Streakrs gaan nu via Cloudinary (goede kwaliteit).' : 'Streakrs gaan nu via Firestore (lage kwaliteit).');
          } catch (e) { X.toast(e?.code ? X.fbErr(e) : (e?.message || 'Opslaan mislukt.')); }
          saving = false; paint();
        });
        return h('label', { class: 'up-check rs-opt' + (off ? ' off' : '') }, rb,
          h('span', { class: 'item-text' }, h('b', { text: title }), h('small', { text: off ? 'Nog niet ingesteld: vul CLOUDINARY_CLOUD en CLOUDINARY_PRESET in js/firebase.js in.' : desc })));
      });
      note.textContent = ST.cfg.storage ? 'Dit geldt voor iedereen, voor alle streakrs die vanaf nu worden verstuurd. Eerder verstuurde streakrs blijven zoals ze zijn.' : 'Er is nog niets gekozen: standaard gaat het via ' + (X.cloudOn ? 'Cloudinary.' : 'Firestore (Cloudinary is niet ingesteld).');
      box.replaceChildren(h('p', { class: 'hint', text: 'Kies hoe streakr-foto’s van iedereen worden opgeslagen en hoe scherp ze zijn.' }), ...rows, note);
    };
    ST.cfgSubs.add(paint);
    paint();
    return box;
  }

  // kleine camera-knop voor in de kop van een DM
  const cameraBtn = (uid) => h('button', { class: 'icon-btn', type: 'button', html: IC.cam, title: 'Streakr sturen', 'aria-label': 'Streakr sturen', onclick: () => openCamera(uid) });

  // streak-teller + nieuw-streakr-blokje naast een vriend in de DM-lijst
  function chip(friendId, friendUid) {
    const st = stateOf(friendId), nw = unopenedFrom(friendUid).length;
    if (st.kind !== 'alive' && !nw) return null;
    const kids = [];
    if (nw) kids.push(h('i', { class: 'stk-new', title: 'Nieuwe streakr' }));
    if (st.kind === 'alive') kids.push(String(st.count), h('img', { src: FLAME, alt: 'streak' }), st.gap === 1 && hoursLeft() <= SAND_H ? h('em', { text: '⏳', title: 'Stuur vandaag nog een streakr' }) : null);
    return h('span', { class: 'stk-chip' + (st.kind === 'alive' && st.gap === 1 && hoursLeft() <= SAND_H ? ' risk' : ''), title: st.kind === 'alive' ? `${st.count} dagen streak` : 'Nieuwe streakr' }, kids);
  }

  function onUnfriend(id) { deleteDoc(doc(db, 'streaks', id)).catch(() => {}); }

  return { start, stop, render, fill, decorateChat, jumpToSnap, buildAdmin, openCamera, openSnap, loadTop, rankOf, badge, chip, cameraBtn, onUnfriend, paintBadge, unopenedCount: () => unopened().length };
}
