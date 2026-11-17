/* Infinitum: muziekstatus via Last.fm (v0.35).
   Hoe het werkt:
   - Spotify / Apple Music geven door wat je afspeelt aan Last.fm ("scrobbelen").
   - Deze app vraagt (via de Cloudflare Worker, POST /lastfm) elke ~45 s wat er NU bij jouw Last.fm-naam speelt.
   - Verandert dat, dan zet de app het in je eigen profiel: users/{uid}.activity = { k:'music', t, a, i, at }.
     Anderen lezen dat mee met het profiel dat de app al volgt (vrienden en serverleden), dus er zijn geen extra luisteraars nodig.
   - Houdt de muziek op (of ga je offline), dan wordt het veld gewist; een veld ouder dan STALE telt bij kijkers niet meer mee.
   - Je Last.fm-naam en keuzes staan alleen bij jezelf: settings/{uid}.lastfm = { user, show, prompt }.
   Spelletjes (Minecraft e.d.) zitten er bewust niet in. */

const POLL_VIS = 45000;      // pagina zichtbaar: elke 45 s vragen
const POLL_HID = 90000;      // pagina op de achtergrond: elke 90 s (zuinig met het gratis Cloudflare-plan)
const BEAT = 150000;         // zelfde nummer nog steeds aan het afspelen: elke 2,5 min het tijdstip verversen
const STALE = 330000;        // geen verversing in 5,5 min -> bij anderen weg
const RETRY_ERR = 300000;    // bij een fout in de instellingen (naam/privé/key) pas na 5 min weer proberen
const MISS_CLEAR = 2;        // pas wissen na 2 keer "speelt niets", zodat de pauze tussen twee nummers niet flikkert
const LFM_NAME = /^[A-Za-z][A-Za-z0-9_-]{1,14}$/;
const ART_OK = /^https:\/\/(?:lastfm\.freetls\.fastly\.net|is\d-ssl\.mzstatic\.com)\/[^\s"'()<>]{1,260}$/;   // Last.fm, of (als Last.fm geen hoes heeft) Apple/iTunes
const NOTE = '\u266A';

export function createLastfm(X) {
  const { h, S, PROF, db, doc, updateDoc, deleteField, auth, toast, fbErr, openDialog, closeDialog, dlg } = X;
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
  async function publish(j) {
    const a = { k: 'music', t: String(j.title).slice(0, 120), a: String(j.artist).slice(0, 120), at: Date.now() };
    if (j.art && ART_OK.test(j.art)) a.i = j.art;
    const mine = S.profile?.activity, ref = st.last || mine;
    const same = ref && ref.t === a.t && ref.a === a.a && (ref.i || '') === (a.i || '');   // v0.35.1: komt de hoes later binnen, dan meteen bijwerken
    if (same && Date.now() - (ref.at || 0) < BEAT) return;   // niets nieuws (ook als een ander apparaat/tabblad het al deed)
    st.last = a;
    try { await updateDoc(meRef(), { activity: a }); }
    catch (e) {
      st.last = null; console.error(e);
      if (!st.warned) { st.warned = true; toast('Muziekstatus opslaan lukt niet. Heeft de beheerder de nieuwe firestore.rules al gedeployed? ' + fbErr(e)); }
    }
  }
  async function clear() {
    const had = st.last || S.profile?.activity;
    st.last = null; st.miss = 0;
    if (!S.me || !had) return;
    try { await updateDoc(meRef(), { activity: deleteField() }); } catch (e) { console.warn('Muziekstatus wissen mislukt', e); }
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
        if (j.playing) { st.miss = 0; st.now = { t: j.title, a: j.artist, i: j.art && ART_OK.test(j.art) ? j.art : '' }; setState('playing', ''); await publish(j); }
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

  /* ---------- weergave (bij jezelf en anderen) ---------- */
  function activityOf(uid, data, noPresence) {
    const d = data || PROF[uid] || (uid === S.me?.uid ? S.profile : null);
    const a = d && d.activity;
    if (!a || a.k !== 'music' || typeof a.t !== 'string' || typeof a.a !== 'string' || !a.t) return null;
    if (!(Date.now() - Number(a.at || 0) < STALE)) return null;
    if (uid !== S.me?.uid && !noPresence && X.presState(uid) === 'offline') return null;   // offline/onzichtbaar = geen muziek tonen
    return a;
  }
  const line = (a) => `${NOTE} ${a.t} \u2013 ${a.a}`;
  function paintAct(el) {
    const a = activityOf(el.dataset.uid);
    el.hidden = !a;
    if (!a) { if (el.textContent) el.textContent = ''; return; }
    const t = line(a);
    if (el.textContent !== t) el.textContent = t;
    el.title = `Luistert naar ${a.t} \u2013 ${a.a}`;
  }
  // klein regeltje onder een naam (zijbalk, chatkop, ledenlijst, eigen kaart)
  function actEl(uid, extra) {
    const el = h('small', { class: 'act' + (extra ? ' ' + extra : ''), 'data-uid': uid });
    paintAct(el);
    return el;
  }
  function paintAll() { document.querySelectorAll('.act[data-uid]').forEach(paintAct); }

  // hoesje: plaatje, of (geen hoes / laadt niet) een muzieknootje
  function artEl(src, cls) {
    const ph = () => h('span', { class: cls + ' ph', text: NOTE });
    if (!src || !ART_OK.test(src)) return ph();
    const img = h('img', { class: cls, src, alt: '', referrerpolicy: 'no-referrer', decoding: 'async' });
    img.addEventListener('error', () => img.replaceWith(ph()), { once: true });
    return img;
  }

  // blok in het profielvenster van iemand anders
  function profileBlock(uid, data) {
    const a = activityOf(uid, data, true);
    if (!a) return null;
    const art = artEl(a.i, 'pf-art');
    return h('div', { class: 'pf-sec pf-music' },
      h('h4', { text: 'Luistert nu naar' }),
      h('div', { class: 'pf-track' }, art, h('div', { class: 'pf-track-t' }, h('b', { text: a.t }), h('small', { text: a.a }))));
  }

  /* ---------- instellingen: sectie "Muziekstatus" ---------- */
  function statusText() {
    if (!cfg().user) return '';
    if (!base()) return 'De pushserver is nog niet ingesteld (beheerder).';
    if (!cfg().show) return 'Staat uit: anderen zien je muziek niet.';
    switch (st.state) {
      case 'playing': return st.now ? `Nu: ${st.now.t} \u2013 ${st.now.a}` : '';
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
      item('muziek muziekstatus last.fm lastfm spotify apple music koppelen handleiding scrobble', true,
        h('p', { class: 'set-lbl', text: 'Muziekstatus' }),
        h('p', { class: 'hint', text: linked ? `Gekoppeld als ${cfg().user} (Last.fm).` : 'Laat zien naar welk nummer je luistert, net als bij Discord. Werkt met Spotify en Apple Music via Last.fm.' }),
        status, h('div', { class: 'lfm-acts' }, acts))
    ];
    if (linked) items.push(item('muziek tonen zichtbaar anderen verbergen privacy last.fm', false,
      toggle('Toon mijn muziek aan anderen', 'Vrienden, serverleden en wie je profiel opent zien dan welk nummer je nu afspeelt. Uit = niemand ziet het. Staat je status op Offline of Onzichtbaar, dan zien anderen het ook niet.',
        cfg().show, (on) => { cfg().show = on; X.saveSet(); refresh(); })));
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
          cfg().user = ''; cfg().show = true; X.saveSet(); closeDialog(); refresh(); X.rerender(); toast('Last.fm is ontkoppeld.');
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
      msg.textContent = j.playing ? `Gekoppeld! Nu speelt: ${j.title} \u2013 ${j.artist}.` : 'Gekoppeld! Er speelt nu niets. Start een nummer in Spotify of Apple Music: binnen een minuut staat het onder je naam.';
      go.hidden = true; fin.hidden = false; fin.focus();
      refresh(); X.rerender();
    };
    const fin = h('button', { class: 'btn-ok', type: 'button', text: 'Klaar', hidden: true, onclick: closeDialog });
    go.addEventListener('click', run);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
    openDialog(
      h('h3', { text: 'Muziekstatus koppelen' }),
      h('p', { class: 'sub', text: 'Infinitum kijkt op Last.fm welk nummer je nu luistert en laat dat aan je vrienden zien. Last.fm krijgt de muziek door van Spotify of Apple Music.' }),
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
      p('Zo werkt het: je muziekapp (Spotify of Apple Music) geeft door aan Last.fm wat je afspeelt. Infinitum kijkt daarna op Last.fm welk nummer je nu luistert en laat dat zien bij je naam, in je profiel en in de ledenlijst. Infinitum krijgt dus nooit toegang tot je Spotify- of Apple Music-account, alleen tot je Last.fm-naam.'),
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
        ul(['Windows (Apple Music-app): download AMWin-RP via de ', lnk('https://github.com/PKBeam/AMWin-RP/releases/', 'releases-pagina op GitHub'), ' (kies bij de nieuwste versie het installatiebestand), installeer het, zet het scrobbelen naar Last.fm aan in de instellingen van het programma en log in bij Last.fm. Laat het programma draaien terwijl je luistert.'],
          ['macOS (Muziek-app): installeer ', lnk('https://apps.apple.com/us/app/scrobbles-for-last-fm/id1344679160?mt=12', 'Scrobbles for Last.fm'), ' uit de Mac App Store, open het en log in bij Last.fm. Laat het programma actief terwijl je luistert. De app kan geld kosten.'],
          'iPhone of iPad: de officiële Last.fm-app werkt hier beperkt mee. Veel mensen gebruiken een app van een andere maker die automatisch doorgeeft, zoals Marvis Pro, Soor, Scrobbly of FastScrobbler. Zoek in de App Store op \u201cLast.fm scrobbler Apple Music\u201d. Sommige kosten geld en het aanbod verandert. Open de app en koppel je Apple Music en je Last.fm-account.',
          'Android: Apple Music doorgeven is hier lastig en wisselt per app. Zoek in de Play Store naar een Last.fm-scrobbler die Apple Music ondersteunt, of gebruik de webspeler-methode hieronder of Spotify.'),
        sub('Webspeler (muziek in je browser)'),
        p('Luister je in de browser, bijvoorbeeld Apple Music op music.apple.com, Spotify Web Player, YouTube Music of SoundCloud? Dan is er een gratis extensie die Last.fm laat weten wat je afspeelt.'),
        ol(['Installeer ', lnk('https://chromewebstore.google.com/detail/web-scrobbler/hhinaapppaileiechjoiifaancjggfjm', 'Web Scrobbler'), ' in Chrome (werkt ook in Edge en andere Chromium-browsers).'],
          'Klik op het icoontje van de extensie en log in bij Last.fm. Geef toestemming.',
          'Open je webspeler en start een nummer. De extensie herkent het en geeft het door. Zie je het icoontje niet, pin de extensie dan vast via het puzzelstuk-icoon in je browser.')),
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
        ol('Start een nummer in Spotify of Apple Music.',
          'Binnen ongeveer een minuut staat onder je naam links bovenaan het nummer en de artiest.',
          'Je vrienden zien het in hun lijst met directe berichten, in de chatkop, in de ledenlijst van een server en in je profiel.')),
      step(6, 'Wie ziet dit, en hoe zet ik het uit?',
        ul('Je muziek is zichtbaar voor andere Infinitum-leden: vrienden, mensen in dezelfde server en wie je profiel opent.',
          'Staat je status op Offline of Onzichtbaar, dan wordt je muziek niet getoond.',
          'Uitzetten kan altijd: Instellingen, Muziekstatus, en zet Toon mijn muziek aan anderen uit. Of kies Ontkoppelen.',
          'De melding om te koppelen kun je uitzetten met Niet meer tonen, of later weer aanzetten bij Instellingen, Muziekstatus.')),
      step(7, 'Problemen oplossen',
        ul('\u201cDeze naam bestaat niet op Last.fm\u201d: controleer de spelling, zonder @. Open last.fm/user/JOUWNAAM in je browser: komt je profiel, dan klopt de naam.',
          '\u201cJe luistergeschiedenis is privé\u201d: doe stap 3.',
          'Er verschijnt niets onder je naam: kijk op last.fm bij je profiel. Staat je nummer daar onder Recent Tracks met \u201cScrobbling now\u201d? Zo niet, dan ligt het aan stap 2 (de koppeling tussen Spotify of Apple Music en Last.fm), niet aan Infinitum. Bij sommige Apple Music-apps worden alleen nummers uit je bibliotheek doorgegeven; voeg het nummer dan eerst toe.',
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
        h('small', { text: 'Koppel Last.fm (werkt met Spotify en Apple Music) en je vrienden zien welk nummer je afspeelt.' })),
      h('div', { class: 'lfm-card-a' },
        h('button', { class: 'btn-ok', type: 'button', text: 'Koppelen', onclick: () => { gone(); openSetup(true); } }),
        h('button', { class: 'ghost sm', type: 'button', text: 'Later', onclick: () => { try { sessionStorage.setItem(laterKey(), '1'); } catch {} gone(); } }),
        h('button', { class: 'linkish', type: 'button', text: 'Niet meer tonen', onclick: () => {
          cfg().prompt = 'never'; X.saveSet(); gone();
          toast('Oké, deze melding komt niet meer. Koppelen kan altijd bij Instellingen, Muziekstatus.');
        } })));
    document.body.append(card);
  }

  return { start, stop, refresh, clear, settingsLoaded, activityOf, actEl, paintAll, profileBlock, settingsSec, openGuide, openSetup, cleanName };
}
