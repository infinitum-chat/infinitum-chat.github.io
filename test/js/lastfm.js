/* Infinitum: muziekstatus via Last.fm (v0.36).
   Hoe het werkt:
   - Spotify / Apple Music / YouTube (via de extensie Web Scrobbler) geven door wat je afspeelt aan Last.fm ("scrobbelen").
   - Deze app vraagt (via de Cloudflare Worker, POST /lastfm) elke ~45 s wat er NU bij jouw Last.fm-naam speelt.
   - Verandert dat, dan zet de app het in je eigen profiel: users/{uid}.activity = { k:'music', t, a, i, at }.
     Anderen lezen dat mee met het profiel dat de app al volgt (vrienden en serverleden), dus er zijn geen extra luisteraars nodig.
   - Houdt de muziek op (of ga je offline), dan wordt het veld gewist; een veld ouder dan STALE telt bij kijkers niet meer mee.
   - Je Last.fm-naam en keuzes staan alleen bij jezelf: settings/{uid}.lastfm = { user, show, prompt }.
   - v0.36: (1) staat "Toon mijn muziek ook als ik offline ben" aan (settings/{uid}.lastfm.bg), dan krijgt de status `bg: true` en toont iedereen hem ook als je
       Offline staat of Infinitum dicht is; de Cloudflare Worker (Cron) houdt hem dan zelf bij (zie worker.js, pollMusic). Standaard uit.
     (2) users/{uid}.music = { n, ms, at, lk }: aantal nummers en luistertijd die Infinitum registreerde; vanaf 1 nummer krijg je de muziekbadge.
   Spelletjes (Minecraft e.d.) zitten er bewust niet in. */

const POLL_VIS = 45000;      // pagina zichtbaar: elke 45 s vragen
const POLL_HID = 90000;      // pagina op de achtergrond: elke 90 s (zuinig met het gratis Cloudflare-plan)
const BEAT = 150000;         // zelfde nummer nog steeds aan het afspelen: elke 2,5 min het tijdstip verversen
const STALE = 330000;        // geen verversing in 5,5 min -> bij anderen weg
const RETRY_ERR = 300000;    // bij een fout in de instellingen (naam/privé/key) pas na 5 min weer proberen
const MISS_CLEAR = 2;        // pas wissen na 2 keer "speelt niets", zodat de pauze tussen twee nummers niet flikkert
const LFM_NAME = /^[A-Za-z][A-Za-z0-9_-]{1,14}$/;
const ART_OK = /^https:\/\/(?:lastfm\.freetls\.fastly\.net|is\d-ssl\.mzstatic\.com|(?:e-)?cdns?-images\.dzcdn\.net)\/[^\s"'()<>]{1,260}$/;   // Last.fm, of (als Last.fm geen hoes heeft) Deezer of Apple/iTunes
const NOTE = '\u266A';
const MUSIC_GAP = 300000;    // tussen twee metingen hooguit 5 min = nog dezelfde luistersessie (zelfde waarde in worker.js)
const MUSIC_FLUSH = 60000;   // bij stoppen: hooguit zoveel luistertijd nog bijtellen

export function createLastfm(X) {
  const { h, S, PROF, db, doc, updateDoc, deleteField, runTransaction, auth, toast, fbErr, openDialog, closeDialog, dlg } = X;
  const st = { timer: 0, busy: false, miss: 0, last: null, lastTick: 0, state: 'off', msg: '', now: null, warned: false, settingsReady: false, promptTimer: 0, promptTries: 0 };
  const cfg = () => X.CFG.lastfm;
  const base = () => X.workerUrl();
  const enabled = () => !!(S.me && cfg().user && cfg().show && base());

  /* ---------- Worker aanroepen ---------- */
  async function ask(user) {
    const url = base();
    if (!url) return { ok: false, code: 'nourl', reason: 'De pushserver (Worker) is nog niet ingesteld: de beheerder moet PUSH_URL in js/firebase.js invullen.' };
    try {
      const idt = await auth.currentUser.getIdToken();
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 9000);
      const r = await fetch(url + '/lastfm', {
        method: 'POST', headers: { Authorization: 'Bearer ' + idt, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user }), signal: ctl.signal
      });
      clearTimeout(to);
      const j = await r.json().catch(() => null);
      return j || { ok: false, code: 'error', reason: 'Onverwacht antwoord van de pushserver (' + r.status + ').' };
    } catch (e) {
      return { ok: false, code: 'net', reason: 'Geen verbinding met de pushserver. Controleer je internet en of de Worker draait.' };
    }
  }
  // naam of volledige profiel-link (https://www.last.fm/user/naam) -> alleen de naam
  function cleanName(v) {
    let s = String(v || '').trim();
    const m = s.match(/last\.fm\/(?:[a-z]{2}\/)?user\/([^/?#\s]+)/i);
    if (m) s = decodeURIComponent(m[1]);
    return s.replace(/^@/, '').trim();
  }

  /* ---------- eigen status publiceren ---------- */
  const meRef = () => doc(db, 'users', S.me.uid);
  // luisterstatistiek (muziekbadge): n = nummers, ms = luistertijd, at = tot wanneer geteld is, lk = laatste nummer. Zelfde rekenwijze als bumpMusic in worker.js
  // en binnen wat firestore.rules toestaan (er kan nooit meer tijd bij dan er echt voorbij is gegaan). `stop`: de muziek is net gestopt.
  function bump(m, key, now, stop) {
    const o = m && typeof m === 'object' ? m : {};
    const n = Math.floor(Number(o.n)) || 0, ms = Math.floor(Number(o.ms)) || 0, at = Math.floor(Number(o.at)) || 0, gap = now - at, lk = String(o.lk || '');
    const cont = at > 0 && gap >= 0 && gap <= MUSIC_GAP;
    if (stop) return cont ? { n, ms: ms + Math.min(gap, MUSIC_FLUSH), at: now, lk } : { n, ms, at, lk };
    return { n: n + (!cont || lk !== key ? 1 : 0), ms: ms + (cont ? Math.min(gap, MUSIC_GAP) : 0), at: now, lk: key };
  }
  async function publish(j) {
    const a = { k: 'music', t: String(j.title).slice(0, 120), a: String(j.artist).slice(0, 120), at: Date.now() };
    if (j.art && ART_OK.test(j.art)) a.i = j.art;
    if (cfg().bg) a.bg = true;   // v0.36: ook tonen als ik offline ben
    const mine = S.profile?.activity, ref = st.last || mine;
    const same = ref && ref.t === a.t && ref.a === a.a && (ref.i || '') === (a.i || '') && !!ref.bg === !!a.bg;   // v0.36: komt de hoes later binnen, dan meteen bijwerken
    if (same && Date.now() - (ref.at || 0) < BEAT) return;   // niets nieuws (ook als een ander apparaat/tabblad/de Worker het al deed)
    st.last = a;
    try {
      // in een transactie: de Worker (achtergrond) en andere apparaten schrijven dezelfde statistiek, zo tellen we nooit dubbel
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(meRef());
        tx.update(meRef(), { activity: a, music: bump(snap.exists() ? snap.data().music : null, a.t + '|' + a.a, a.at, false) });
      });
    } catch (e) {
      st.last = null; console.error(e);
      if (!st.warned) { st.warned = true; toast('Muziekstatus opslaan lukt niet. Heeft de beheerder de nieuwe firestore.rules al gedeployed? ' + fbErr(e)); }
    }
  }
  async function clear() {
    const had = st.last || S.profile?.activity;
    st.last = null; st.miss = 0;
    if (!S.me || !had) return;
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(meRef()), m = snap.exists() ? snap.data().music : null;
        const upd = { activity: deleteField() };
        if (m && typeof m === 'object') upd.music = bump(m, '', Date.now(), true);   // de laatste luisterminuut nog bijtellen
        tx.update(meRef(), upd);
      });
    } catch (e) {
      console.warn('Muziekstatus wissen mislukt, nog een keer zonder statistiek', e);
      try { await updateDoc(meRef(), { activity: deleteField() }); } catch (e2) { console.warn('Muziekstatus wissen mislukt', e2); }
    }
  }

  /* ---------- de lus ---------- */
  function schedule(ms) {
    clearTimeout(st.timer);
    st.timer = setTimeout(tick, ms || (document.hidden ? POLL_HID : POLL_VIS));
  }
  async function tick() {
    clearTimeout(st.timer);
    if (!enabled()) { setState('off', ''); return; }
    if (navigator.onLine === false) { schedule(); return; }
    if (X.invisible()) { await clear(); setState('hidden', 'Je staat op Onzichtbaar: je muziek wordt nu niet getoond.'); schedule(); return; }
    if (st.busy) return;
    st.busy = true; st.lastTick = Date.now();
    let next = 0;
    try {
      const j = await ask(cfg().user);
      if (!enabled()) return;   // tussendoor ontkoppeld of uitgezet
      if (j.ok) {
        if (j.playing) { st.miss = 0; st.now = { t: j.title, a: j.artist, i: j.art && ART_OK.test(j.art) ? j.art : '', v: j.v || 1, dbg: String(j.dbg || '').slice(0, 120) }; setState('playing', ''); await publish(j); }
        else { st.now = null; setState('quiet', ''); if (++st.miss >= MISS_CLEAR) await clear(); }
      } else if (['nouser', 'private', 'badkey', 'nokey', 'badname', 'nourl'].includes(j.code)) {
        st.now = null; setState(j.code, j.reason || ''); await clear(); next = RETRY_ERR;
      } else {
        setState('net', j.reason || 'Last.fm is even niet te bereiken. We proberen het straks opnieuw.');   // tijdelijk: status niet wissen
      }
    } finally { st.busy = false; schedule(next); }
  }
  function setState(s, msg) { st.state = s; st.msg = msg; paintStatus(); paintAll(); }

  // aanzetten/uitzetten nadat de instellingen zijn veranderd (koppelen, ontkoppelen, schakelaar)
  function refresh() {
    clearTimeout(st.timer);
    if (enabled()) { st.miss = 0; tick(); }
    else { st.now = null; clear(); setState('off', ''); }
  }
  function start() {
    stop();
    if (enabled()) schedule(1500);
    schedulePrompt();
  }
  function stop() {
    clearTimeout(st.timer); clearTimeout(st.promptTimer);
    st.busy = false; st.last = null; st.miss = 0; st.now = null; st.state = 'off'; st.msg = ''; st.settingsReady = false; st.promptTries = 0; st.warned = false;
    document.querySelector('.lfm-card')?.remove();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !enabled() || Date.now() - st.lastTick < 20000) return;
    tick();
  });
  // elke minuut: afgelopen (verlopen) muziek bij anderen weghalen zonder dat er een nieuw bericht binnenkomt
  setInterval(() => { if (S.me) paintAll(); }, 60000);

  /* ---------- lange tekst: scrollen i.p.v. "..." ---------- */
  // Past de tekst niet, dan schuift hij langzaam heen en weer (met een korte pauze aan beide kanten). Past hij wel, dan blijft hij stil staan.
  const REDUCE = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  function fit(el) {
    const m = el.firstElementChild;
    if (!m || !m.classList.contains('mq')) return;
    el.classList.remove('mq-run'); el.style.removeProperty('--mq-d'); el.style.removeProperty('--mq-t');
    if (REDUCE.matches || !el.clientWidth) return;   // minder beweging aan: gewoon met "..." afkappen
    const over = Math.ceil(m.offsetWidth - el.clientWidth);
    if (over > 2) {
      el.style.setProperty('--mq-d', -(over + 2) + 'px');
      el.style.setProperty('--mq-t', Math.max(6, Math.round(over / 22 + 4)) + 's');
      el.classList.add('mq-run');
    }
  }
  const RO = typeof ResizeObserver === 'function' ? new ResizeObserver(es => es.forEach(e => {
    const w = Math.round(e.contentRect.width);
    if (e.target._mqw !== w) { e.target._mqw = w; fit(e.target); }   // alleen bij een andere breedte, anders krijg je een lus
  })) : null;
  function setMq(el, text) {
    let m = el.firstElementChild;
    if (!m || !m.classList.contains('mq')) { el.textContent = ''; m = h('span', { class: 'mq' }); el.append(m); if (RO) RO.observe(el); }
    if (m.textContent !== text) {
      m.textContent = text; el.classList.remove('mq-run');
      requestAnimationFrame(() => { if (el.isConnected) fit(el); });
    }
  }
  const mq = (tag, text) => { const el = h(tag, { title: text }); setMq(el, text); return el; };
  /* ---------- icoontjes van de muziekdiensten (ingebouwd, geen extra verzoeken) ---------- */
  const SVC = {
    youtube: { n: 'YouTube', svg: '<rect x="1" y="4.5" width="22" height="15" rx="4.5" fill="#f00"/><path d="M10 8.8l5.6 3.2-5.6 3.2z" fill="#fff"/>' },
    ytmusic: { n: 'YouTube Music', svg: '<circle cx="12" cy="12" r="11" fill="#f03"/><circle cx="12" cy="12" r="6.2" fill="none" stroke="#fff" stroke-width="1.5"/><path d="M10.4 9.3l4 2.7-4 2.7z" fill="#fff"/>' },
    spotify: { n: 'Spotify', svg: '<circle cx="12" cy="12" r="11" fill="#1ed760"/><path d="M5.9 9.2c4.2-1.2 8.7-.8 12.3 1.3M6.7 12.5c3.5-1 6.9-.6 9.8 1.1M7.6 15.6c2.7-.7 5-.4 7.3.9" fill="none" stroke="#111" stroke-width="1.7" stroke-linecap="round"/>' },
    apple: { n: 'Apple Music', svg: '<rect x="1" y="1" width="22" height="22" rx="5.5" fill="#fa243c"/><path d="M16.3 6.2v8.6a2.3 2.3 0 1 1-1.3-2.1V8.4l-5 1v6.2a2.3 2.3 0 1 1-1.3-2.1V7.4z" fill="#fff"/>' },
    soundcloud: { n: 'SoundCloud', svg: '<rect x="1" y="1" width="22" height="22" rx="5.5" fill="#f50"/><path d="M5.5 15.5v-3M7.7 15.5v-5M9.9 15.5V9.6M12.1 15.5H17a2.4 2.4 0 0 0 .3-4.8A4.2 4.2 0 0 0 12.1 9.3z" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' },
    beatport: { n: 'Beatport', svg: '<rect x="1" y="1" width="22" height="22" rx="5.5" fill="#01ff95"/><text x="12" y="17.5" font-size="15" font-weight="800" text-anchor="middle" fill="#000" font-family="Arial,sans-serif">b</text>' },
    web: { n: 'Zoek op het web', svg: '<circle cx="12" cy="12" r="10.5" fill="#3b82f6"/><g fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round"><ellipse cx="12" cy="12" rx="4.4" ry="10.5"/><path d="M1.8 9h20.4M1.8 15h20.4"/></g>' }
  };
  const svcIcon = (id) => h('span', { class: 'svc', html: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + SVC[id].svg + '</svg>' });
  // Last.fm geeft niet door WAAR je luistert. Vindt de Worker geen hoes bij titel + artiest (Last.fm, Deezer, iTunes), dan lijkt het
  // niet op een echt nummer uit een catalogus (festival, liveset, clip, SoundCloud-mix...): dan tonen we een web-icoon en zoeklinks.
  const isVideo = (a) => !a.i;
  const WHY = 'Dit nummer is niet gevonden in een muziekdienst. Meestal komt dat doordat het via de browser-extensie Web Scrobbler wordt doorgegeven vanaf een website, zoals een YouTube-video, een liveset of een mix. Dan kennen we alleen de titel en artiest, en kunnen we alleen zoeken.';
  // zoeklinks voor een nummer (we kennen alleen titel en artiest, dus zoeken we het op): [dienst, adres]
  function trackLinks(a) {
    const q = encodeURIComponent(a.a + ' ' + a.t);
    const all = [['spotify', 'https://open.spotify.com/search/' + q], ['apple', 'https://music.apple.com/search?term=' + q],
      ['soundcloud', 'https://soundcloud.com/search?q=' + q], ['ytmusic', 'https://music.youtube.com/search?q=' + q],
      ['beatport', 'https://www.beatport.com/search?q=' + q]];
    // geen hoes gevonden: alle gewone links, plus zoeken op het web en YouTube (daar komt zo'n nummer meestal vandaan)
    if (isVideo(a)) return [['web', 'https://www.google.com/search?q=' + q], ...all.slice(0, 4), ['youtube', 'https://www.youtube.com/results?search_query=' + q], all[4]];
    return all;
  }
  // "Zoek op het web": een website kan niet zien welke zoekmachine jouw apparaat gebruikt. Op Android (Chrome, Samsung Internet) kan het wel:
  // daar vragen we Android zelf om te zoeken, dus met je eigen standaard. Overal anders valt het terug op Google.
  const ANDROID = /Android/i.test(navigator.userAgent) && /Chrome\//.test(navigator.userAgent) && !/Firefox\//.test(navigator.userAgent);
  function webSearchHref(a, fallback) {
    if (!ANDROID) return fallback;
    return 'intent://#Intent;action=android.intent.action.WEB_SEARCH;S.query=' + encodeURIComponent(a.a + ' ' + a.t) + ';S.browser_fallback_url=' + encodeURIComponent(fallback) + ';end';
  }
  const linkEl = (id, url, cls, a) => {
    const el = h('a', { class: cls, href: id === 'web' && a ? webSearchHref(a, url) : url, target: '_blank', rel: 'noopener noreferrer', role: 'menuitem' }, svcIcon(id), h('span', { text: SVC[id].n }));
    if (id === 'web' && ANDROID) el.removeAttribute('target');   // intent-adres moet in hetzelfde tabblad starten
    return el;
  };

  /* ---------- weergave (bij jezelf en anderen) ---------- */
  function activityOf(uid, data, noPresence) {
    const d = data || PROF[uid] || (uid === S.me?.uid ? S.profile : null);
    const a = d && d.activity;
    if (!a || a.k !== 'music' || typeof a.t !== 'string' || typeof a.a !== 'string' || !a.t) return null;
    if (!(Date.now() - Number(a.at || 0) < STALE)) return null;
    if (uid !== S.me?.uid && !noPresence && !a.bg && X.presState(uid) === 'offline') return null;   // offline/onzichtbaar = geen muziek tonen, tenzij die persoon "ook offline tonen" aan heeft (v0.36)
    return a;
  }
  const line = (a) => `${NOTE} ${a.t} \u2013 ${a.a}`;
  function paintAct(el) {
    const a = activityOf(el.dataset.uid);
    el.hidden = !a;
    if (!a) { if (el.firstChild) el.textContent = ''; return; }
    setMq(el, line(a));
    el.title = `Luistert naar ${a.t} \u2013 ${a.a}`;
  }
  // klein regeltje onder een naam (zijbalk, chatkop, ledenlijst, eigen kaart)
  function actEl(uid, extra) {
    const el = h('small', { class: 'act' + (extra ? ' ' + extra : ''), 'data-uid': uid });
    paintAct(el);
    return el;
  }
  function paintAll() { document.querySelectorAll('.act[data-uid]').forEach(paintAct); document.querySelectorAll('.cm[data-uid]').forEach(paintCm); }

  // hoesje: plaatje; geen hoes (lijkt niet op een echt nummer) = web-icoontje; hoes die niet laadt = muzieknootje
  function artEl(src, cls) {
    const ph = () => h('span', { class: cls + ' ph', text: NOTE });
    if (!src || !ART_OK.test(src)) return h('span', { class: cls + ' ph web', title: 'Waarom een web-icoon? ' + WHY }, svcIcon('web'));
    const img = h('img', { class: cls, src, alt: '', referrerpolicy: 'no-referrer', decoding: 'async' });
    img.addEventListener('error', () => img.replaceWith(ph()), { once: true });
    return img;
  }

  /* ---------- menuutje met de links (v0.36) ---------- */
  // Zelfde uiterlijk als het "gelezen door"-vakje. Opent door op het nummer te klikken of te tikken (of op de drie puntjes), niet alleen op de puntjes.
  let MENU = null;
  const hostFor = (el) => { const d = el.ownerDocument; return el.closest('dialog') || (d.fullscreenElement && d.fullscreenElement !== d.body ? d.fullscreenElement : null) || d.body; };
  function closeMenu() {
    const m = MENU; if (!m) return;
    MENU = null; clearInterval(m.w);
    m.doc.removeEventListener('pointerdown', m.out, true); m.doc.removeEventListener('keydown', m.key, true); m.doc.removeEventListener('scroll', m.scr, true);
    m.el.remove(); m.anchor.classList.remove('open'); m.anchor.setAttribute('aria-expanded', 'false');
  }
  // algemeen vakje onder een knop (links bij een nummer, of de statistiek bij de muziekbadge); makeEl bouwt het vakje
  function openPanel(anchor, makeEl, onOpen) {
    if (MENU && MENU.anchor === anchor) { closeMenu(); return; }
    closeMenu();
    const doc = anchor.ownerDocument, win = doc.defaultView || window;
    const el = makeEl();
    el.addEventListener('click', e => e.stopPropagation());
    hostFor(anchor).append(el);
    // Popover (top layer): een profielvenster is een <dialog> met overflow en animatie, daarin zou een los vakje worden afgeknipt of verschoven
    try { el.showPopover?.(); } catch { /* oudere browser: gewoon een los vakje */ }
    const r = anchor.getBoundingClientRect(), w = el.getBoundingClientRect();
    let top = r.bottom + 6; if (top + w.height > win.innerHeight - 8) top = Math.max(8, r.top - w.height - 6);
    el.style.top = top + 'px'; el.style.left = Math.max(8, Math.min(r.right - w.width, win.innerWidth - w.width - 8)) + 'px';
    anchor.classList.add('open'); anchor.setAttribute('aria-expanded', 'true');
    const m = MENU = { el, anchor, doc };
    m.out = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
    m.key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeMenu(); anchor.focus?.(); } };
    m.scr = (e) => { if (!el.contains(e.target)) closeMenu(); };
    doc.addEventListener('pointerdown', m.out, true); doc.addEventListener('keydown', m.key, true); doc.addEventListener('scroll', m.scr, true);
    m.w = setInterval(() => { if (!anchor.isConnected) closeMenu(); }, 1000);
    onOpen?.();
  }
  function openMenu(anchor, a, onOpen) {
    openPanel(anchor, () => {
      const vid = isVideo(a);
      const rows = trackLinks(a).map(([id, u]) => { const r = linkEl(id, u, 'who-row cm-item', a); r.addEventListener('click', () => setTimeout(closeMenu, 0)); return r; });
      return h('div', { class: 'who cm-menu', role: 'menu', popover: 'manual', 'aria-label': 'Nummer openen of zoeken' },
        h('div', { class: 'who-h', text: vid ? 'Zoeken' : 'Open in' }),
        h('div', { class: 'who-list' }, rows),
        vid ? h('div', { class: 'cm-why' }, h('b', { text: 'Waarom een web-icoon?' }), h('span', { text: WHY })) : null);
    }, onOpen);
  }

  /* ---------- muziekbadge (v0.36) ---------- */
  // Staat op je profiel zodra Infinitum minstens 1 nummer van je heeft geregistreerd (users/{uid}.music.n >= 1). Klikken toont hoeveel uur en hoeveel nummers.
  const fmtN = (n) => Number(n).toLocaleString('nl-NL');
  function fmtTime(ms) {
    const min = Math.floor(Math.max(0, ms) / 60000);
    return min < 60 ? min + ' min' : (min / 60).toLocaleString('nl-NL', { maximumFractionDigits: 1 }) + ' uur';
  }
  function statsPanel(n, ms) {
    return h('div', { class: 'who cm-menu mus-pop', role: 'dialog', popover: 'manual', 'aria-label': 'Muziek geluisterd via Infinitum' },
      h('div', { class: 'who-h', text: 'Geluisterd via Infinitum' }),
      h('div', { class: 'mus-stats' },
        h('div', { class: 'mus-s' }, h('b', { text: fmtTime(ms) }), h('small', { text: 'luistertijd' })),
        h('div', { class: 'mus-s' }, h('b', { text: fmtN(n) }), h('small', { text: n === 1 ? 'nummer' : 'nummers' }))),
      h('div', { class: 'cm-why' }, h('span', { text: 'Alleen muziek die Infinitum heeft geregistreerd (via Last.fm). De tijd is bij benadering.' })));
  }
  function badge(uid, prof) {
    const m = prof && prof.music, n = Math.floor(Number(m && m.n)) || 0;
    if (n < 1) return null;
    const ms = Math.max(0, Number(m.ms) || 0);
    const el = h('button', { class: 'badge music-badge', type: 'button', style: '--c:#ff62d3', title: 'Klik om te zien hoeveel er is geluisterd', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
      h('span', { class: 'bd-ic', text: NOTE }), h('b', { text: 'Muziek' }));
    el.addEventListener('click', e => { e.stopPropagation(); openPanel(el, () => statsPanel(n, ms)); });
    return el;
  }
  // het nummer als kaartje: hoes, titel, artiest en drie puntjes. Klikken ergens op het kaartje opent het menuutje.
  function trackCard(a, onOpen) {
    const card = h('div', { class: 'pf-track', role: 'button', tabindex: '0', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: isVideo(a) ? 'Waarom een web-icoon? ' + WHY : 'Klik om het nummer te openen' },
      artEl(a.i, 'pf-art'), h('div', { class: 'pf-track-t' }, mq('b', a.t), mq('small', a.a)), h('span', { class: 'pf-go', 'aria-hidden': 'true', text: '\u22EF' }));
    card.addEventListener('click', e => { e.stopPropagation(); openMenu(card, a, onOpen); });
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openMenu(card, a, onOpen); } });
    return card;
  }
  // blok in het profielvenster
  function profileBlock(uid, data) {
    const a = activityOf(uid, data, true);
    if (!a) return null;
    return h('div', { class: 'pf-sec pf-music' }, h('h4', { text: 'Luistert nu naar' }), trackCard(a));
  }


  /* ---------- muzieknootje in gesprekken en streams (v0.36) ---------- */
  // Klein nootje bij iemands naam of op diens stream (naast het label Scherp/Vloeiend). Muis erboven (of tikken op een telefoon) = pop-up met
  // hoes, titel, artiest en de links. Alleen zichtbaar als die persoon nu muziek luistert (zelfde regels als de rest van de muziekstatus).
  const HOVER = window.matchMedia ? matchMedia('(hover: hover) and (pointer: fine)') : { matches: false };
  function placeCm(el) {   // schuif het nootje naast het label Scherp/Vloeiend (dat verschilt van breedte)
    const p = el.parentElement;
    if (!p || el.classList.contains('inl')) return;
    const b = p.querySelector(':scope > .vr-mode');
    el.style.setProperty('--cm-x', b ? (b.offsetWidth + 6) + 'px' : '0px');
  }
  function fillPop(pop, a, el) {
    pop.dataset.k = a.t + '|' + a.a + '|' + (a.i || '');
    pop.replaceChildren(trackCard(a, () => { el._pin = true; clearTimeout(el._cmT); }));   // menuutje open = pop-up blijft staan
  }
  function closePop(el) {
    const pop = el._pop; if (!pop) return;
    clearTimeout(el._cmT); clearInterval(el._cmW);
    if (MENU && pop.contains(MENU.anchor)) closeMenu();
    if (el._cmDoc) { el._cmDoc.removeEventListener('pointerdown', el._cmOut, true); el._cmDoc.removeEventListener('keydown', el._cmKey, true); }
    pop.remove(); el._pop = null; el._pin = false; el.classList.remove('on'); el.setAttribute('aria-expanded', 'false');
  }
  function openPop(el, pin) {
    const a = activityOf(el.dataset.uid);
    if (!a) { closePop(el); return; }
    clearTimeout(el._cmT);
    if (pin) el._pin = true;
    if (el._pop && el._pop.isConnected) { if (el._pop.dataset.k !== a.t + '|' + a.a + '|' + (a.i || '')) fillPop(el._pop, a, el); return; }
    const doc = el.ownerDocument, win = doc.defaultView || window;
    const pop = h('div', { class: 'cm-pop', role: 'dialog', 'aria-label': 'Waar luistert deze persoon naar?' });
    fillPop(pop, a, el);
    hostFor(el).append(pop);   // in (nep-)volledig scherm moet het venster IN het fullscreen-element staan, anders ligt het achter de stream
    el._pop = pop; el.classList.add('on'); el.setAttribute('aria-expanded', 'true');
    const r = el.getBoundingClientRect(), w = pop.offsetWidth, ph = pop.offsetHeight, vw = win.innerWidth, vh = win.innerHeight;
    let top = r.bottom + 8; if (top + ph > vh - 8) top = Math.max(8, r.top - ph - 8);
    pop.style.left = Math.max(8, Math.min(r.left, vw - w - 8)) + 'px'; pop.style.top = top + 'px';
    const leave = () => { if (!el._pin) { clearTimeout(el._cmT); el._cmT = setTimeout(() => closePop(el), 250); } };
    pop.addEventListener('mouseenter', () => clearTimeout(el._cmT));
    pop.addEventListener('mouseleave', leave);
    pop.addEventListener('click', e => e.stopPropagation());
    el._cmDoc = doc;
    el._cmOut = (e) => { if (!el.contains(e.target) && !pop.contains(e.target) && !e.target.closest?.('.cm-menu')) closePop(el); };
    el._cmKey = (e) => { if (e.key !== 'Escape') return; e.stopPropagation(); if (MENU) { e.preventDefault(); closeMenu(); return; } closePop(el); el.focus?.(); };
    doc.addEventListener('pointerdown', el._cmOut, true); doc.addEventListener('keydown', el._cmKey, true);
    el._cmW = setInterval(() => { if (!el.isConnected || el.hidden) closePop(el); }, 1000);   // het vlak is opnieuw getekend of de muziek is gestopt
  }
  function paintCm(el) {
    const a = activityOf(el.dataset.uid);
    el.hidden = !a;
    if (!a) { if (el._pop) closePop(el); el.title = ''; el.removeAttribute('aria-label'); return; }
    const t = `Luistert naar ${a.t} \u2013 ${a.a}`;
    el.title = t; el.setAttribute('aria-label', t);
    if (el._pop) openPop(el, false);   // nieuw nummer: pop-up bijwerken
    placeCm(el);
  }
  // extra = 'inl' voor een nootje dat gewoon naast een naam staat (gesprekskaart, deelnemerslijst); zonder = zwevend op een stream
  function callBadge(uid, extra) {
    const el = h('button', { class: 'cm' + (extra ? ' ' + extra : ''), type: 'button', 'data-uid': uid, hidden: true, text: NOTE, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' });
    el.addEventListener('click', e => { e.stopPropagation(); if (el._pop && el._pin) closePop(el); else openPop(el, true); });   // tikken (telefoon) of klikken
    el.addEventListener('dblclick', e => e.stopPropagation());
    el.addEventListener('keydown', e => e.stopPropagation());
    el.addEventListener('mouseenter', () => { if (HOVER.matches) openPop(el, false); });
    el.addEventListener('mouseleave', () => { if (!el._pin && el._pop) { clearTimeout(el._cmT); el._cmT = setTimeout(() => closePop(el), 250); } });
    paintCm(el);
    requestAnimationFrame(() => { if (el.isConnected) placeCm(el); });
    return el;
  }

  /* ---------- instellingen: sectie "Muziekstatus" ---------- */
  function statusText() {
    if (!cfg().user) return '';
    if (!base()) return 'De pushserver is nog niet ingesteld (beheerder).';
    if (!cfg().show) return 'Staat uit: anderen zien je muziek niet.';
    switch (st.state) {
      case 'playing': {
        if (!st.now) return '';
        const t = `Nu: ${st.now.t} \u2013 ${st.now.a}`;
        if (st.now.i) return t;
        if (st.now.v < 3) return t + ' (geen hoes: de Worker is nog niet bijgewerkt, deploy de nieuwe worker.js)';
        return t + ' (geen hoes gevonden' + (st.now.dbg ? ' \u2013 ' + st.now.dbg : '') + ')';
      }
      case 'quiet': return 'Er speelt nu niets op Last.fm.';
      case 'off': return 'Bezig met controleren\u2026';
      default: return st.msg || '';
    }
  }
  function paintStatus() {
    const box = document.getElementById('lfmNowArt');
    if (box) { box.replaceChildren(); const on = st.state === 'playing' && st.now && cfg().show; box.hidden = !on; if (on) box.append(artEl(st.now.i, 'pf-art')); }
    const el = document.getElementById('lfmStatusLine');
    if (!el) return;
    const t = statusText(), bad = ['nouser', 'private', 'badkey', 'nokey', 'badname', 'nourl', 'net'].includes(st.state);
    el.textContent = t; el.classList.toggle('bad', bad); el.hidden = !t;
  }
  const toggle = (title, desc, checked, on) => {
    const cb = h('input', { type: 'checkbox' }); cb.checked = !!checked;
    cb.addEventListener('change', () => on(cb.checked));
    return h('label', { class: 'tog' }, h('span', { class: 'tog-text' }, h('b', { text: title }), h('small', { text: desc })), cb, h('i'));
  };
  function settingsSec(sec, item) {
    const linked = !!cfg().user;
    const status = h('div', { class: 'lfm-now' }, h('span', { id: 'lfmNowArt', hidden: true }), h('p', { class: 'lfm-status', id: 'lfmStatusLine' }));
    const acts = linked
      ? [h('button', { class: 'ghost sm', type: 'button', text: 'Naam wijzigen', onclick: () => openSetup() }),
         h('button', { class: 'ghost sm', type: 'button', text: 'Nu controleren', onclick: () => { if (enabled()) { setState('off', ''); tick(); } } }),
         h('button', { class: 'ghost sm', type: 'button', text: 'Ontkoppelen', onclick: disconnect }),
         h('button', { class: 'ghost sm', type: 'button', text: 'Handleiding', onclick: () => openGuide() })]
      : [h('button', { class: 'btn-ok', type: 'button', text: 'Last.fm koppelen', onclick: () => openSetup() }),
         h('button', { class: 'ghost sm', type: 'button', text: 'Handleiding', onclick: () => openGuide() })];
    const items = [
      item('muziek muziekstatus last.fm lastfm spotify apple music youtube koppelen handleiding scrobble', true,
        h('p', { class: 'set-lbl', text: 'Muziekstatus' }),
        h('p', { class: 'hint', text: linked ? `Gekoppeld als ${cfg().user} (Last.fm).` : 'Laat zien naar welk nummer je luistert, net als bij Discord. Werkt met Spotify, Apple Music en YouTube (ook festivals en optredens) via Last.fm.' }),
        status, h('div', { class: 'lfm-acts' }, acts))
    ];
    if (linked) items.push(item('muziek tonen zichtbaar anderen verbergen privacy last.fm', false,
      toggle('Toon mijn muziek aan anderen', 'Vrienden, serverleden en wie je profiel opent zien dan welk nummer je nu afspeelt. Uit = niemand ziet het. Staat je status op Offline of Onzichtbaar, dan zien anderen het ook niet.',
        cfg().show, (on) => { cfg().show = on; X.saveSet(); refresh(); })));
    if (linked) items.push(item('muziek offline achtergrond dicht tonen last.fm', false,
      toggle('Toon mijn muziek ook als ik offline ben', 'Standaard uit. Aan = anderen zien je muziek ook als je Offline staat of Infinitum dicht is: Infinitum kijkt dan zelf op Last.fm (ongeveer elke 2 minuten), je hoeft de app niet open te hebben. Onzichtbaar blijft je muziek verbergen. Werkt alleen als Toon mijn muziek aan anderen aan staat.',
        !!cfg().bg, (on) => { cfg().bg = on; X.saveSet(); refresh(); })));
    items.push(item('melding koppelen herinnering last.fm', false,
      toggle('Melding om Last.fm te koppelen', 'Een melding als je Infinitum opent en nog niets hebt gekoppeld. Uit = die melding komt niet meer.',
        cfg().prompt !== 'never', (on) => { cfg().prompt = on ? 'ask' : 'never'; X.saveSet(); })));
    const el = sec('muziek', 'Muziekstatus', ...items);
    queueMicrotask(paintStatus);
    return el;
  }
  function disconnect() {
    openDialog(
      h('h3', { text: 'Last.fm ontkoppelen?' }),
      h('p', { class: 'sub', text: 'Je muziek verdwijnt meteen uit je profiel. Je kunt later opnieuw koppelen.' }),
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'ghost', type: 'button', text: 'Annuleren', onclick: closeDialog }),
        h('button', { class: 'btn-no', type: 'button', text: 'Ontkoppelen', onclick: () => {
          cfg().user = ''; cfg().show = true; cfg().bg = false; X.saveSet(); closeDialog(); refresh(); X.rerender(); toast('Last.fm is ontkoppeld.');
        } })));
  }

  /* ---------- koppelen ---------- */
  function openSetup(fromPrompt) {
    const inp = h('input', { class: 'inp', maxlength: 120, placeholder: 'Je Last.fm-naam, bijv. kaasfan', value: cfg().user || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Last.fm-naam' });
    const msg = h('p', { class: 'lfm-msg', role: 'status' });
    const go = h('button', { class: 'btn-ok', type: 'button', text: 'Koppelen en testen' });
    const run = async () => {
      const name = cleanName(inp.value);
      msg.className = 'lfm-msg'; msg.textContent = '';
      if (!LFM_NAME.test(name)) { msg.classList.add('bad'); msg.textContent = 'Vul je Last.fm-naam in (2 tot 15 tekens: letters, cijfers, _ en -). Je mag ook de link naar je Last.fm-profiel plakken.'; return; }
      go.disabled = true; go.textContent = 'Even kijken\u2026';
      const j = await ask(name);
      go.disabled = false; go.textContent = 'Koppelen en testen';
      if (!j.ok) { msg.classList.add('bad'); msg.textContent = j.reason || 'Dat is niet gelukt.'; return; }
      cfg().user = name; cfg().show = true; if (cfg().prompt === 'never') cfg().prompt = 'ask';
      X.saveSet();
      msg.classList.add('good');
      msg.textContent = j.playing ? `Gekoppeld! Nu speelt: ${j.title} \u2013 ${j.artist}.` : 'Gekoppeld! Er speelt nu niets. Start een nummer in Spotify of Apple Music, of een muziekvideo op YouTube: binnen een minuut staat het onder je naam.';
      go.hidden = true; fin.hidden = false; fin.focus();
      refresh(); X.rerender();
    };
    const fin = h('button', { class: 'btn-ok', type: 'button', text: 'Klaar', hidden: true, onclick: closeDialog });
    go.addEventListener('click', run);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
    openDialog(
      h('h3', { text: 'Muziekstatus koppelen' }),
      h('p', { class: 'sub', text: 'Infinitum kijkt op Last.fm welk nummer je nu luistert en laat dat aan je vrienden zien. Last.fm krijgt de muziek door van Spotify, Apple Music of YouTube.' }),
      h('label', { class: 'field' }, h('span', { text: 'Last.fm-naam' }), inp),
      msg,
      h('p', { class: 'hint', text: 'Nog geen Last.fm of weet je niet hoe het werkt? Bekijk de handleiding, dat kost een paar minuten.' }),
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'ghost', type: 'button', text: 'Handleiding', onclick: () => openGuide(() => openSetup(fromPrompt)) }),
        h('button', { class: 'ghost', type: 'button', text: 'Sluiten', onclick: closeDialog }), go, fin));
    setTimeout(() => inp.focus(), 50);
  }

  /* ---------- de handleiding ---------- */
  function openGuide(back) {
    const step = (n, title, ...body) => h('details', { class: 'lfm-step', open: n <= 1 },
      h('summary', {}, h('span', { class: 'lfm-n', text: String(n) }), title), h('div', { class: 'lfm-body' }, ...body));
    const li = (t) => h('li', {}, ...[].concat(t));   // tekst, of een lijstje van tekst en links
    const ol = (...items) => h('ol', {}, items.map(li));
    const ul = (...items) => h('ul', {}, items.map(li));
    const lnk = (url, text) => h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text });
    const p = (t) => h('p', { text: t });
    const sub = (t) => h('h5', { text: t });
    const guide = h('div', { class: 'lfm-guide' },
      p('Zo werkt het: je muziekapp of browser (Spotify, Apple Music of YouTube) geeft door aan Last.fm wat je afspeelt. Infinitum kijkt daarna op Last.fm welk nummer je nu luistert en laat dat zien bij je naam, in je profiel en in de ledenlijst. Infinitum krijgt dus nooit toegang tot je Spotify- of Apple Music-account, alleen tot je Last.fm-naam. Kijk je muziekvideo\u2019s, festivals of optredens op YouTube? Dan werkt dat ook, via de extensie Web Scrobbler (zie stap 2).'),
      step(1, 'Maak een Last.fm-account (gratis)',
        ol('Ga naar last.fm en kies Sign up (aanmelden). Vul gebruikersnaam, e-mail en wachtwoord in.',
          'Bevestig je e-mailadres via de mail die je krijgt.',
          'Onthoud je gebruikersnaam. Je ziet hem in de link van je profiel: last.fm/user/JOUWNAAM.'),
        p('Heb je al een Last.fm-account? Dan kun je deze stap overslaan.')),
      step(2, 'Laat je muziekdienst aan Last.fm doorgeven wat je luistert',
        sub('Spotify (het makkelijkst)'),
        ol('Log in op last.fm op een computer of in je browser.',
          'Ga naar Settings (Instellingen) en open Applications (Apps).',
          'Klik naast Spotify Scrobbling op Connect en log in bij Spotify. Geef toestemming.',
          'Klaar: Spotify geeft nu door wat je afspeelt, ook op je telefoon en andere apparaten.'),
        p('Let op: in een privé-sessie van Spotify kan het zijn dat er niets wordt doorgegeven.'),
        sub('Apple Music'),
        p('Apple Music heeft geen eigen koppeling met Last.fm. Je hebt een extra programma of app nodig dat Last.fm laat weten wat je afspeelt. Kies wat bij jou past:'),
        ul(['Windows (Apple Music-app): download Last.fm Scrobbler via de ', lnk('https://github.com/dagkan/lastfm-scrobbler/releases', 'releases-pagina op GitHub'), '. Download bij de nieuwste versie het .exe-bestand (niet het .dmg-bestand, want dat is voor de Mac), installeer het, zet het scrobbelen naar Last.fm aan en log in bij Last.fm. Laat het programma draaien terwijl je luistert.'],
          ['macOS (Muziek-app): installeer ', lnk('https://apps.apple.com/us/app/scrobbles-for-last-fm/id1344679160?mt=12', 'Scrobbles for Last.fm'), ' uit de Mac App Store, open het en log in bij Last.fm. Laat het programma actief terwijl je luistert. De app kan geld kosten.'],
          'iPhone of iPad: de officiële Last.fm-app werkt hier beperkt mee. Veel mensen gebruiken een app van een andere maker die automatisch doorgeeft, zoals Marvis Pro, Soor, Scrobbly of FastScrobbler. Zoek in de App Store op \u201cLast.fm scrobbler Apple Music\u201d. Sommige kosten geld en het aanbod verandert. Open de app en koppel je Apple Music en je Last.fm-account.',
          'Android: Apple Music doorgeven is hier lastig en wisselt per app. Zoek in de Play Store naar een Last.fm-scrobbler die Apple Music ondersteunt, of gebruik de webspeler-methode hieronder of Spotify.'),
        sub('Webspeler (muziek in je browser)'),
        p('Luister of kijk je in de browser? Denk aan Apple Music op music.apple.com, Spotify Web Player, YouTube Music, SoundCloud, en ook gewone YouTube-video\u2019s met muziek, zoals festivals, optredens, livesets en clips van artiesten. Met deze gratis extensie geeft je browser door aan Last.fm wat je afspeelt, en dan staat het ook in Infinitum.'),
        ol(['Installeer ', lnk('https://chromewebstore.google.com/detail/web-scrobbler/hhinaapppaileiechjoiifaancjggfjm', 'Web Scrobbler'), ' in Chrome (werkt ook in Edge en andere Chromium-browsers).'],
          'Klik op het icoontje van de extensie en log in bij Last.fm. Geef toestemming.',
          'Open je webspeler of een YouTube-video en start het afspelen. De extensie herkent artiest en titel en geeft het door. Zie je het icoontje niet, pin de extensie dan vast via het puzzelstuk-icoon in je browser.',
          'Bij YouTube haalt de extensie artiest en titel uit de titel van de video. Klopt dat niet (bij een festival of optreden staat er vaak meer in de titel), klik dan op het icoontje van de extensie en pas artiest en titel aan voordat het wordt doorgegeven.')),
      step(3, 'Zet je luistergeschiedenis op Last.fm niet op privé',
        p('Dit vergeten is de meest voorkomende reden dat er niets verschijnt.'),
        ol('Ga op last.fm naar Settings en open Privacy.',
          'Zorg dat de optie om recent geluisterde nummers te verbergen (Hide recent listening information) UIT staat.',
          'Klik op Save (opslaan).')),
      step(4, 'Koppel Last.fm in Infinitum',
        ol('Ga in Infinitum naar Instellingen en open Muziekstatus. Heb je de melding \u201cToon wat je luistert\u201d gezien, dan kun je daar op Koppelen klikken.',
          'Klik op Last.fm koppelen. Typ je Last.fm-naam in, of plak de link naar je Last.fm-profiel.',
          'Klik op Koppelen en testen. Staat er \u201cGekoppeld!\u201d, dan werkt het. Staat er een foutmelding, lees dan hieronder bij Problemen oplossen.')),
      step(5, 'Testen',
        ol('Start een nummer in Spotify of Apple Music, of een muziekvideo of optreden op YouTube (met Web Scrobbler aan).',
          'Binnen ongeveer een minuut staat onder je naam links bovenaan het nummer en de artiest.',
          'Je vrienden zien het in hun lijst met directe berichten, in de chatkop, in de ledenlijst van een server en in je profiel.')),
      step(6, 'Wie ziet dit, en hoe zet ik het uit?',
        ul('Je muziek is zichtbaar voor andere Infinitum-leden: vrienden, mensen in dezelfde server en wie je profiel opent.',
          'Staat je status op Offline of Onzichtbaar, dan wordt je muziek niet getoond. Wil je dat het wel kan als je Offline staat of Infinitum dicht is? Zet dan in Instellingen, Muziekstatus, \u201cToon mijn muziek ook als ik offline ben\u201d aan (staat standaard uit). Infinitum kijkt dan zelf op Last.fm, ongeveer elke 2 minuten. Onzichtbaar blijft je muziek altijd verbergen.',
          'Muziekbadge: zodra Infinitum minstens 1 nummer van je heeft geregistreerd, krijg je een Muziek-badge op je profiel. Klikken op die badge laat zien hoeveel uur en hoeveel nummers Infinitum van je heeft geregistreerd (alleen wat via Last.fm is doorgekomen, de tijd is bij benadering).',
          'Uitzetten kan altijd: Instellingen, Muziekstatus, en zet Toon mijn muziek aan anderen uit. Of kies Ontkoppelen.',
          'De melding om te koppelen kun je uitzetten met Niet meer tonen, of later weer aanzetten bij Instellingen, Muziekstatus.')),
      step(7, 'Problemen oplossen',
        ul('\u201cDeze naam bestaat niet op Last.fm\u201d: controleer de spelling, zonder @. Open last.fm/user/JOUWNAAM in je browser: komt je profiel, dan klopt de naam.',
          '\u201cJe luistergeschiedenis is privé\u201d: doe stap 3.',
          'Er verschijnt niets onder je naam: kijk op last.fm bij je profiel. Staat je nummer daar onder Recent Tracks met \u201cScrobbling now\u201d? Zo niet, dan ligt het aan stap 2 (de koppeling tussen Spotify of Apple Music en Last.fm), niet aan Infinitum. Bij sommige Apple Music-apps worden alleen nummers uit je bibliotheek doorgegeven; voeg het nummer dan eerst toe.',
          'YouTube-video staat er niet of fout? Staat Web Scrobbler aan en ben je ingelogd bij Last.fm? Klik op het icoontje van de extensie: daar zie je wat hij herkent en kun je artiest en titel aanpassen. Lange video\u2019s zoals een hele livestream worden soms niet als nummer herkend.',
          'Het nummer blijft nog even staan na een pauze: Last.fm zet \u201cspeelt nu\u201d pas weg als het nummer zou zijn afgelopen. Daarna verdwijnt het vanzelf.',
          'Vrienden zien niets: ben je online? Bij Offline of Onzichtbaar wordt het verborgen. Het kan ook een minuut duren.',
          '\u201cLast.fm is nog niet ingesteld\u201d: de beheerder van Infinitum moet de koppeling met Last.fm nog afmaken (zie README).'),
        p('Spelletjes (zoals Minecraft) worden niet getoond; dit gaat alleen over muziek.')));
    openDialog(
      h('h3', { text: 'Muziekstatus: handleiding' }),
      guide,
      h('div', { class: 'dlg-actions' },
        back ? h('button', { class: 'ghost', type: 'button', text: 'Terug', onclick: back }) : null,
        h('button', { class: 'ghost', type: 'button', text: 'Sluiten', onclick: closeDialog }),
        !cfg().user ? h('button', { class: 'btn-ok', type: 'button', text: 'Last.fm koppelen', onclick: () => openSetup() }) : null));
    dlg.classList.add('wide');
  }

  /* ---------- melding bij het eerste bezoek ---------- */
  const laterKey = () => 'infinitum-lfm-later-' + (S.me?.uid || '');
  function schedulePrompt() {
    clearTimeout(st.promptTimer);
    st.promptTimer = setTimeout(maybePrompt, 7000);
  }
  function settingsLoaded() { st.settingsReady = true; }
  function maybePrompt() {
    if (!S.me || !base()) return;
    if (!st.settingsReady) { if (++st.promptTries < 8) st.promptTimer = setTimeout(maybePrompt, 4000); return; }   // wacht tot je instellingen binnen zijn
    if (cfg().user || cfg().prompt === 'never') return;
    try { if (sessionStorage.getItem(laterKey())) return; } catch {}
    // niet bovenop het cookievenster, een geopend venster of een gesprek
    if (document.querySelector('.cookie-wrap, .lfm-card') || dlg.open || document.fullscreenElement) { st.promptTimer = setTimeout(maybePrompt, 15000); return; }
    const gone = () => card.remove();
    const card = h('div', { class: 'lfm-card panel', role: 'dialog', 'aria-label': 'Muziekstatus koppelen' },
      h('div', { class: 'lfm-card-t' }, h('b', { text: 'Toon wat je luistert' }),
        h('small', { text: 'Koppel Last.fm (werkt met Spotify, Apple Music en YouTube) en je vrienden zien wat je luistert.' })),
      h('div', { class: 'lfm-card-a' },
        h('button', { class: 'btn-ok', type: 'button', text: 'Koppelen', onclick: () => { gone(); openSetup(true); } }),
        h('button', { class: 'ghost sm', type: 'button', text: 'Later', onclick: () => { try { sessionStorage.setItem(laterKey(), '1'); } catch {} gone(); } }),
        h('button', { class: 'linkish', type: 'button', text: 'Niet meer tonen', onclick: () => {
          cfg().prompt = 'never'; X.saveSet(); gone();
          toast('Oké, deze melding komt niet meer. Koppelen kan altijd bij Instellingen, Muziekstatus.');
        } })));
    document.body.append(card);
  }

  return { start, stop, refresh, clear, settingsLoaded, activityOf, actEl, paintAll, callBadge, profileBlock, badge, settingsSec, openGuide, openSetup, cleanName };
}
