/* Infinitum v0.37: beheer-schermen voor Admin
   - Overzicht        (tegels + snelkoppelingen)
   - Voorwaarden      (nieuwe editor: lijst, schrijven/voorbeeld, teller, Ctrl+S)
   - Account wissen   (eerst een overzicht van ALLES wat bij het account hoort, dan wissen met voortgang en controle)
   - Opslag           (aantal documenten per collectie, Firebase- en Cloudinary-gebruik, opruimacties, losse inlogaccounts)
   Het wissen en het gebruik lezen gaat via de Cloudflare Worker (POST /admin): alleen de Worker heeft de rechten om een
   inlogaccount te verwijderen en om overal in Firestore te zoeken. Zie worker.js en README (v0.37). */

const ico = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
export const ADM_IC = {
  dash: ico('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
  db: ico('<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'),
  cloud: ico('<path d="M7 18a4 4 0 0 1-.5-7.97A6 6 0 0 1 18 9.5 4.25 4.25 0 0 1 17.5 18z"/>'),
  spark: ico('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18"/>'),
  refresh: ico('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'),
  ext: ico('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  server: ico('<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>'),
  file: ico('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>'),
  chat: ico('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z"/>'),
  alert: ico('<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>'),
  key: ico('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>')
};

const FB = 'https://console.firebase.google.com/u/0/project/chat-a5794';
const LINKS = [
  { t: 'Gebruik en kosten', d: 'Reads, writes en opslag per dag', u: FB + '/usage', ic: 'dash' },
  { t: 'Firestore-database', d: 'Alle documenten bekijken en aanpassen', u: FB + '/firestore', ic: 'db' },
  { t: 'Inlogaccounts', d: 'Authentication → Gebruikers', u: FB + '/authentication/users', ic: 'key' },
  { t: 'Cloud Messaging', d: 'Pushmeldingen', u: FB + '/settings/cloudmessaging', ic: 'chat' },
  { t: 'Cloudinary', d: 'Foto’s en gebruik', u: 'https://console.cloudinary.com/', ic: 'cloud' },
  { t: 'Cloudflare Worker', d: 'Pushserver en beheer', u: 'https://dash.cloudflare.com/', ic: 'server' }
];

// Spark (gratis plan)-limieten van Firestore per dag, en 1 GiB opslag
const SPARK = { reads: 50000, writes: 20000, deletes: 20000, bytes: 1024 ** 3 };

// verzamelingen die we tellen (naam -> label). "~" = alle collecties met die naam, op elk niveau.
const COLLS = {
  users: 'Profielen', usernames: 'Gebruikersnamen', settings: 'Instellingen', presence: 'Aanwezigheid', presenceSettings: 'Aanwezigheidsinstellingen', liveness: 'Levenstekens',
  readState: 'Gelezen-status', pushTokens: 'Pushtokens', pushTests: 'Testmeldingen', notifications: 'Meldingen', subscriptions: 'Abonnementen', friendships: 'Vriendschappen',
  snaps: 'Streakrs', streaks: 'Streaks', streakUsers: 'Streak-herstellers', blocks: 'Blokkades', reports: 'Rapporten', moderation: 'Moderatiestand',
  modLog: 'Moderatielogboek', spamLocks: 'Spamblokkades', spamLog: 'Spam-logboek', calls: 'Oproepen', servers: 'Servers', badges: 'Badges', features: 'Functietabel',
  legal: 'Voorwaarden', config: 'Configuratie',
  '~messages': 'Berichten (DM’s + servers)', '~channels': 'Kanalen', '~devices': 'Apparaten', '~typing': 'Typ-indicators', '~reads': 'Leesmarkeringen', '~voice': 'Spraakdeelnemers',
  '~sigs': 'Belsignalen', '~notes': 'Rapport-notities'
};
// gemiddelde grootte van een document in bytes (schatting, inclusief indexen; zonder grote afbeeldingen die in Firestore staan)
const AVG = { users: 1800, usernames: 130, settings: 900, presence: 220, presenceSettings: 220, liveness: 120, readState: 320, pushTokens: 650, pushTests: 120, notifications: 450, subscriptions: 750,
  friendships: 280, snaps: 1500, streaks: 320, streakUsers: 90, blocks: 220, reports: 950, moderation: 320, modLog: 380, spamLocks: 220, spamLog: 950, calls: 3500, servers: 2300,
  badges: 420, features: 950, legal: 9000, config: 320, '~messages': 400, '~channels': 650, '~devices': 380, '~typing': 130, '~reads': 160, '~voice': 260, '~sigs': 3500, '~notes': 380 };

const nf = new Intl.NumberFormat('nl-NL');
const fmtN = (n) => (n == null ? '–' : nf.format(Math.round(n)));
const fmtBytes = (b) => {
  if (b == null || !isFinite(b)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = Math.abs(b);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (b < 0 ? '-' : '') + (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1).replace('.', ',')) + ' ' + u[i];
};
const pct = (a, b) => (b ? Math.min(100, (a / b) * 100) : 0);
const todayNl = () => { const t = new Date(); return `${t.getDate()}-${t.getMonth() + 1}-${t.getFullYear()}`; };

export function createAdminTools(D) {
  const { h, I, S, db, toast, fbErr, auth } = D;
  const wide = () => matchMedia('(min-width: 1100px)').matches;

  /* ---------- gesprek met de Worker ---------- */
  async function adm(body) {
    const base = D.workerUrl();
    if (!base) throw new Error('PUSH_URL in js/firebase.js is leeg: dit gaat via je Cloudflare Worker.');
    const tok = await auth.currentUser.getIdToken();
    let r;
    try { r = await fetch(base + '/admin', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch { throw new Error('De Worker is niet bereikbaar. Controleer je internetverbinding en PUSH_URL.'); }
    const j = await r.json().catch(() => null);
    if (r.status === 404 && (!j || j.reason === 'niet gevonden')) throw Object.assign(new Error('Je Worker kent dit nog niet. Plak de nieuwe worker.js in Cloudflare (Workers → jouw Worker → Edit code) en klik op Deploy.'), { fatal: true });
    if (!r.ok || !j || j.ok === false) throw Object.assign(new Error((j && j.reason) || ('Fout ' + r.status)), { fatal: r.status === 401 || r.status === 403 || r.status === 400 });
    return j;
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /* =====================  Overzicht  ===================== */
  let ovPaint = null, stgPaint = null;
  function buildOverview(go) {
    const tiles = h('div', { class: 'ov-tiles' }), cards = h('div', { class: 'ov-cards' }), recent = h('div', { class: 'ov-recent' });
    const tile = (label, value, hint, tone, to) => h(to ? 'button' : 'div', { class: 'ov-tile' + (tone ? ' ' + tone : ''), type: to ? 'button' : null, onclick: to ? () => go(to) : null },
      h('b', { text: value }), h('span', { text: label }), hint ? h('small', { text: hint }) : null);
    ovPaint = () => {
      const list = D.SUBS.list, plus = list.filter(u => u.tier === 'plus').length, prime = list.filter(u => u.tier === 'prime').length;
      const req = D.needsMe().length, rep = D.RPT.open.length;
      tiles.replaceChildren(
        tile('Gebruikers', D.SUBS.ready ? fmtN(list.length) + (list.length >= 500 ? '+' : '') : '…', 'met een profiel', '', 'people'),
        tile('Infinitum+ / Prime', D.SUBS.ready ? `${plus} / ${prime}` : '…', 'betalende abonnementen', '', 'people'),
        tile('Aanvragen voor jou', String(req), req ? 'wacht op jouw stem' : 'alles beoordeeld', req ? 'warn' : 'ok', 'requests'),
        tile('Open rapporten', String(rep), rep ? 'melding van gebruikers' : 'niets open', rep ? 'warn' : 'ok', 'reports'),
        tile('Moderators', String(D.modCount()), 'beheerders', '', 'people'));
      const newest = [...list].filter(u => u.createdAt?.toDate).sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis()).slice(0, 6);
      recent.replaceChildren(h('h4', { class: 'adm-h', text: 'Nieuwste gebruikers' }),
        newest.length ? h('div', { class: 'ov-list' }, newest.map(u => h('div', { class: 'ov-user' }, D.avatar(u.uid, u.username, 32, true),
          h('span', { class: 'item-text' }, h('b', { text: u.username || 'Onbekend' }), h('small', { text: D.fmtWhen(u.createdAt) }))))) : h('p', { class: 'hint', text: D.SUBS.ready ? 'Nog niemand.' : 'Laden…' }));
    };
    const go2 = [
      ['requests', 'Aanvragen', 'Upgrade-aanvragen beoordelen', I.star], ['people', 'Mensen', 'Beheren, resetten en accounts wissen', I.user],
      ['reports', 'Rapporten', 'Gemelde berichten en gebruikers', I.flag], ['mod', 'Moderatie', 'Waarschuwingen, time-outs en bans', I.shield],
      ['storage', 'Opslag', 'Gebruik, opruimen en beheer', ADM_IC.db], ['legal', 'Voorwaarden', 'Teksten bewerken', ADM_IC.file]];
    cards.append(...go2.map(([id, t, d, ic]) => h('button', { class: 'ov-card', type: 'button', onclick: () => go(id) },
      h('span', { class: 'set-ic', html: ic }), h('span', { class: 'item-text' }, h('b', { text: t }), h('small', { text: d })))));
    ovPaint();
    return h('div', { class: 'ov' }, tiles, h('h4', { class: 'adm-h', text: 'Ga direct naar' }), cards, recent);
  }

  /* =====================  Voorwaarden  ===================== */
  const LG_ICON = { terms: ADM_IC.file, privacy: I.lock, rules: I.shield };
  const LG_HINT = { terms: 'Artikel 1: Titel', privacy: '1. Titel', rules: '1. Titel' };
  function buildLegalEditor() {
    const docsCol = h('div', { class: 'lg-docs', role: 'tablist' });
    const ta = h('textarea', { class: 'inp lg-ta', maxlength: 30000, spellcheck: 'true', 'aria-label': 'Tekst van het document' });
    const paper = h('div', { class: 'lg-paper' });
    const title = h('h3', { class: 'lg-title' }), chip = h('span', { class: 'lg-chip' });
    const counter = h('span', { class: 'lg-count' }), msg = h('p', { class: 'lg-msg', role: 'status' });
    const save = h('button', { class: 'glow', type: 'button', text: 'Opslaan' });
    const revert = h('button', { class: 'ghost sm', type: 'button', text: 'Wijzigingen ongedaan maken' });
    const dflt = h('button', { class: 'ghost sm', type: 'button', text: 'Standaardtekst terugzetten' });
    const addBtn = h('button', { class: 'ghost sm', type: 'button', text: '+ Kop' });
    const modes = h('div', { class: 'lg-modes seg', role: 'tablist' });
    const root = h('div', { class: 'lg' });
    const info = {}; let cur = null, base = '', mode = wide() ? 'split' : 'write';

    const dateOf = (t) => (String(t).match(/^laatst bijgewerkt:\s*(.+)$/im) || [])[1] || '';
    const isDirty = () => cur && ta.value !== base;
    const paintDocs = () => {
      docsCol.replaceChildren(...D.LEGAL_DOCS.map(d => {
        const i = info[d.id], active = d.id === cur;
        return h('button', { type: 'button', role: 'tab', 'aria-selected': active ? 'true' : 'false', class: 'lg-doc' + (active ? ' active' : ''), onclick: () => load(d.id) },
          h('span', { class: 'lg-doc-ic', html: LG_ICON[d.id] }),
          h('span', { class: 'item-text' }, h('b', { text: d.title }),
            h('small', { text: !i ? 'Laden…' : (i.custom ? 'Aangepast' : 'Standaardtekst') + (dateOf(i.text) ? ' · ' + dateOf(i.text) : '') })),
          active && isDirty() ? h('span', { class: 'lg-dot', title: 'Niet opgeslagen' }) : null);
      }));
    };
    const paintStatus = () => {
      const i = info[cur], dirty = isDirty();
      chip.className = 'lg-chip ' + (dirty ? 'warn' : i?.custom ? 'ok' : '');
      chip.textContent = dirty ? 'Niet opgeslagen' : i?.custom ? 'Gepubliceerd' : 'Standaardtekst (nog niet gepubliceerd)';
      const words = (ta.value.match(/\S+/g) || []).length;
      counter.textContent = `${fmtN(ta.value.length)} / 30.000 tekens · ${fmtN(words)} woorden`;
      counter.classList.toggle('over', ta.value.length > 29000);
      save.disabled = !dirty && !!i?.custom;
      revert.disabled = !dirty;
      paintDocs();
    };
    let t = 0;
    const onInput = () => { paintStatus(); clearTimeout(t); t = setTimeout(() => paper.replaceChildren(D.renderLegalText(ta.value)), 140); };
    ta.addEventListener('input', onInput);
    ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(); } });

    async function load(id, force) {
      if (!force && id === cur) return;
      if (!force && isDirty() && !confirm('Je hebt wijzigingen die nog niet zijn opgeslagen. Weggooien?')) return;
      cur = id; msg.textContent = ''; msg.className = 'lg-msg';
      title.textContent = D.LEGAL_DOCS.find(d => d.id === id).title;
      ta.disabled = true; ta.value = 'Laden…'; paintDocs();
      const d = await D.loadLegal(id, !!force);
      if (cur !== id) return;
      info[id] = d; base = d.text; ta.value = d.text; ta.disabled = false;
      paper.replaceChildren(D.renderLegalText(d.text)); paintStatus();
    }
    async function doSave() {
      if (!isDirty() && info[cur]?.custom) return;
      let text = ta.value.trim();
      if (text.length < 20) { msg.className = 'lg-msg err'; msg.textContent = 'De tekst is te kort.'; return; }
      text = /^laatst bijgewerkt:.*$/im.test(text) ? text.replace(/^laatst bijgewerkt:.*$/im, 'Laatst bijgewerkt: ' + todayNl()) : text;
      save.disabled = true; save.textContent = 'Opslaan…';
      try {
        await D.setDoc(D.doc(db, 'legal', cur), { text, updatedAt: D.serverTimestamp(), by: S.me.uid });
        const d = await D.loadLegal(cur, true); info[cur] = d; base = d.text; ta.value = d.text;
        paper.replaceChildren(D.renderLegalText(d.text));
        msg.className = 'lg-msg ok'; msg.textContent = 'Opgeslagen. Gebruikers zien de nieuwe tekst meteen.';
      } catch (e) { msg.className = 'lg-msg err'; msg.textContent = fbErr(e); }
      finally { save.textContent = 'Opslaan'; paintStatus(); }
    }
    save.onclick = doSave;
    revert.onclick = () => { ta.value = base; msg.textContent = ''; onInput(); };
    dflt.onclick = () => {
      if (ta.value.trim() && ta.value !== D.LEGAL_DEFAULT[cur] && !confirm('De huidige tekst in het veld wordt vervangen door de standaardtekst (nog niet opgeslagen). Doorgaan?')) return;
      ta.value = D.LEGAL_DEFAULT[cur]; msg.className = 'lg-msg'; msg.textContent = 'Standaardtekst ingevuld. Klik op Opslaan om hem te publiceren.'; onInput();
    };
    addBtn.onclick = () => {
      const art = cur === 'terms';
      const nums = [...ta.value.matchAll(art ? /^Artikel\s+(\d+)/gim : /^(\d+)\.\s/gm)].map(x => +x[1]);
      const n = (nums.length ? Math.max(...nums) : 0) + 1;
      const ins = (ta.value && !ta.value.endsWith('\n') ? '\n' : '') + '\n' + (art ? `Artikel ${n}: ` : `${n}. `) + 'Titel\n';
      ta.focus(); ta.setRangeText(ins, ta.value.length, ta.value.length, 'end'); ta.scrollTop = ta.scrollHeight; onInput();
    };
    const setMode = (m) => { mode = m; root.dataset.mode = m; [...modes.children].forEach(b => b.classList.toggle('active', b.dataset.m === m)); };
    for (const [m, l, c] of [['write', 'Schrijven', ''], ['preview', 'Voorbeeld', ''], ['split', 'Naast elkaar', 'lg-only-wide']]) {
      modes.append(h('button', { type: 'button', role: 'tab', 'data-m': m, class: c, text: l, onclick: () => setMode(m) }));
    }
    setMode(mode);

    const help = h('details', { class: 'lg-help' }, h('summary', { text: 'Hoe schrijf ik dit?' }),
      h('ul', {}, h('li', {}, h('b', { text: 'Eerste regel' }), ' wordt de titel.'),
        h('li', {}, h('code', { text: 'Artikel 3: Titel' }), ' of ', h('code', { text: '3. Titel' }), ' wordt een kop.'),
        h('li', {}, h('code', { text: 'Woord: uitleg' }), ' zet het woord vet.'),
        h('li', {}, h('code', { text: 'Laatst bijgewerkt: …' }), ' wordt bij het opslaan automatisch de datum van vandaag.'),
        h('li', {}, 'Een lege regel start een nieuwe alinea. ', h('kbd', { text: 'Ctrl' }), '+', h('kbd', { text: 'S' }), ' slaat op.')));

    root.append(
      h('aside', { class: 'lg-side' }, h('h4', { class: 'adm-h', text: 'Documenten' }), docsCol,
        h('p', { class: 'lg-note', text: 'Gebruikers zien deze teksten bij het registreren, onder het inlogscherm en in Instellingen.' })),
      h('section', { class: 'lg-main panel' },
        h('header', { class: 'lg-head' }, h('div', { class: 'lg-ttl' }, title, chip), h('div', { class: 'lg-tools' }, addBtn, dflt, revert)),
        h('div', { class: 'lg-bar' }, modes, help),
        h('div', { class: 'lg-panes' }, ta, h('div', { class: 'lg-prev' }, h('div', { class: 'lg-prev-lbl', text: 'Zo zien gebruikers het' }), paper)),
        h('footer', { class: 'lg-foot' }, h('div', { class: 'lg-meta' }, counter, msg), save)));
    D.LEGAL_DOCS.forEach(d => D.loadLegal(d.id).then(x => { info[d.id] = x; if (d.id !== cur) paintDocs(); }));
    load(D.LEGAL_DOCS[0].id);
    return root;
  }

  /* =====================  Account wissen  ===================== */
  const CAT = {
    profile: ['Profiel en account', I.user, 'Profiel, gebruikersnaam, instellingen, abonnement'],
    dm: ['Vrienden en DM’s', ADM_IC.chat, 'Vriendschappen en alle berichten in hun DM-chats (ook die van de ander)'],
    servers: ['Eigen servers', ADM_IC.server, 'Hele server met kanalen, berichten en leden'],
    srvmsg: ['Andere servers', I.hash, 'Zijn/haar berichten en lidmaatschap'],
    snaps: ['Streakrs en streaks', I.image, 'Verstuurde en ontvangen streakrs'],
    notif: ['Meldingen en apparaten', I.bell, 'Inbox, pushtokens'],
    mod: ['Moderatie en rapporten', I.shield, 'Logboeken, rapporten en blokkades door moderators'],
    misc: ['Overig', I.gear, 'Aanwezigheid, sessies, oproepen, blokkades'],
    auth: ['Inlogaccount', I.lock, 'Het account zelf (Firebase Authentication)']
  };
  const CAT_ORDER = Object.keys(CAT);

  // taken uitvoeren in stukjes, tot alles klaar is
  async function runEngine(uid, mode, tasks, onTick, stale) {
    const st = new Map(tasks.map(t => [t.id, { t, n: 0, done: false, tries: 0, skips: 0, err: '', media: { cld: 0, r2: 0, failed: 0, skipped: 0 } }]));
    const size = mode === 'count' ? 24 : 8;
    let pending = [...tasks], guard = 0, fails = 0;
    while (pending.length && guard++ < 4000) {
      if (stale()) throw new Error('afgebroken');
      const batch = pending.slice(0, size);
      let res;
      try { res = (await adm({ action: 'run', uid, mode, tasks: batch })).results; fails = 0; }
      catch (e) { if (e.fatal || ++fails > 3) throw e; await sleep(900 * fails); continue; }
      const back = [];
      for (const r of res) {
        const s = st.get(r.id); if (!s) continue;
        if (r.error) { s.err = r.error; if (++s.tries < 3) back.push(s.t); else s.done = true; continue; }
        if (r.skipped) { if (++s.skips > 60) { s.done = true; s.err = 'Te veel pogingen'; } else back.push(s.t); continue; }
        s.n += r.n || 0; for (const k in (r.media || {})) s.media[k] += r.media[k];
        if (r.more) back.push(s.t); else s.done = true;
      }
      pending = [...back, ...pending.slice(batch.length)];
      onTick(st, tasks.length - pending.length);
    }
    return st;
  }
  const sumBy = (st) => {
    const by = {}; for (const s of st.values()) (by[s.t.cat] ||= []).push(s);
    return by;
  };

  function openDeleteUser(u) {
    const uid = u.uid, shown = u.username || u.email || uid;
    let token = 0; const stale = (my) => () => my !== token;
    const body = h('div', { class: 'du' });
    D.openDialog(h('h3', { text: 'Account verwijderen' }), body);
    D.dlg.classList.add('wide', 'du-dlg');
    const head = (extra) => h('div', { class: 'du-head' }, D.avatar(uid, u.username || '?', 52, !!u.username),
      h('div', { class: 'item-text' }, h('b', { text: shown }), h('small', { class: 'mono', text: uid })), extra || null);
    const close = h('button', { class: 'ghost', type: 'button', text: 'Sluiten', onclick: () => D.closeDialog() });

    const bar = (label) => {
      const fill = h('i'), lab = h('span', { class: 'du-bar-l', text: label });
      return { el: h('div', { class: 'du-prog' }, lab, h('div', { class: 'du-bar' }, fill)), set(p, l) { fill.style.width = Math.max(3, Math.min(100, p)) + '%'; if (l) lab.textContent = l; } };
    };
    const fail = (e, retry) => {
      body.replaceChildren(head(), h('div', { class: 'du-warn bad' }, h('span', { html: ADM_IC.alert }), h('div', {}, h('b', { text: 'Dit lukte niet' }), h('p', { text: e.message || String(e) }))),
        h('div', { class: 'dlg-actions' }, close, retry ? h('button', { class: 'glow', type: 'button', text: 'Opnieuw proberen', onclick: retry }) : null));
    };

    async function scan() {
      const my = ++token;
      const p = bar('Overzicht ophalen…'); p.set(6);
      body.replaceChildren(head(), h('p', { class: 'sub', text: 'Even geduld: we zoeken alles op wat bij dit account hoort. Er wordt nog niets verwijderd.' }), p.el);
      try {
        const plan = await adm({ action: 'plan', uid });
        if (my !== token) return;
        p.set(15, 'Aantallen tellen…');
        const st = await runEngine(uid, 'count', plan.tasks, (s, done) => p.set(15 + 85 * done / plan.tasks.length), stale(my));
        if (my !== token) return;
        confirmView(plan, st);
      } catch (e) { if (my === token) fail(e, scan); }
    }

    function confirmView(plan, st) {
      const by = sumBy(st), total = [...st.values()].reduce((a, s) => a + s.n, 0);
      const name = plan.user.hasProfile ? plan.user.username : '';
      const cards = CAT_ORDER.map(id => {
        const list = by[id] || []; if (!list.length) return null;
        const merged = new Map();
        for (const s of list) { const k = s.t.label; const m = merged.get(k) || { n: 0, k: 0 }; m.n += s.n; m.k++; merged.set(k, m); }
        const rows = [...merged].filter(([, m]) => m.n > 0);
        const sum = list.reduce((a, s) => a + s.n, 0), [t, ic, d] = CAT[id];
        return h('div', { class: 'du-cat' + (sum ? '' : ' empty') },
          h('span', { class: 'du-ic', html: ic }),
          h('div', { class: 'du-cat-b' }, h('div', { class: 'du-cat-h' }, h('b', { text: t }), h('span', { class: 'du-num', text: sum ? fmtN(sum) : 'niets' })),
            sum ? h('ul', {}, rows.map(([l, m]) => h('li', {}, h('span', { text: l + (m.k > 1 ? ` (${m.k}×)` : '') }), h('b', { text: fmtN(m.n) })))) : h('small', { text: d })));
      });
      const notes = [];
      if (plan.ownedServers.length) notes.push(['bad', `Hij/zij is eigenaar van ${plan.ownedServers.length === 1 ? 'een server' : plan.ownedServers.length + ' servers'}: ${plan.ownedServers.map(x => '“' + x + '”').join(', ')}. Alles daarin wordt verwijderd, ook de berichten van andere leden.`]);
      if (plan.skippedServers) notes.push(['bad', `Er zijn ${plan.skippedServers} servers overgeslagen (te veel in één keer). Voer deze actie daarna nog een keer uit om de rest op te ruimen.`]);
      if (!plan.user.hasProfile) notes.push(['info', 'Er is geen profiel meer gevonden. Dit ruimt alleen nog losse resten en het inlogaccount op.']);
      notes.push(plan.media.cloudinary ? ['ok', 'Foto’s bij Cloudinary die bij dit account horen worden ook verwijderd.']
        : ['info', 'Foto’s bij Cloudinary blijven staan: de Worker heeft geen Cloudinary-sleutels (zie README v0.37). In Firestore wordt wel alles verwijderd.']);
      const need = name || 'verwijderen';
      const inp = h('input', { class: 'inp', autocomplete: 'off', placeholder: `Typ “${need}” om te bevestigen`, 'aria-label': 'Bevestiging' });
      const go = h('button', { class: 'btn-danger', type: 'button', text: 'Alles definitief verwijderen', disabled: true });
      inp.addEventListener('input', () => { go.disabled = inp.value.trim().toLowerCase() !== need.toLowerCase(); });
      go.onclick = () => wipe(plan, st);
      body.replaceChildren(head(h('div', { class: 'du-total' }, h('b', { text: fmtN(total) }), h('span', { text: total === 1 ? 'item' : 'items' }))),
        h('p', { class: 'sub', text: 'Dit staat op dit moment in de database. Na het bevestigen wordt alles hieronder definitief verwijderd en kan het niet terug.' }),
        h('div', { class: 'du-cats' }, cards),
        ...notes.map(([k, t]) => h('div', { class: 'du-warn ' + k }, h('span', { html: k === 'ok' ? I.check : ADM_IC.alert }), h('p', { text: t }))),
        h('div', { class: 'du-confirm' }, inp),
        h('div', { class: 'dlg-actions' }, close, go));
      inp.focus();
    }

    async function wipe(plan, counted) {
      const my = ++token;
      const main = plan.tasks.filter(t => t.kind !== 'auth'), authT = plan.tasks.filter(t => t.kind === 'auth');
      const p = bar('Bezig met verwijderen…'); p.set(3);
      const log = h('p', { class: 'sub', text: 'Sluit dit venster niet. Het kan even duren als er veel berichten zijn.' });
      body.replaceChildren(head(), log, p.el);
      try {
        const st = await runEngine(uid, 'delete', main, (s, done) => { p.set(3 + 85 * done / main.length, `Verwijderen… ${done} van ${main.length} onderdelen`); }, stale(my));
        if (my !== token) return;
        p.set(92, 'Inlogaccount verwijderen…');
        const st2 = authT.length ? await runEngine(uid, 'delete', authT, () => {}, stale(my)) : new Map();
        if (my !== token) return;
        p.set(96, 'Controleren of alles weg is…');
        const all = new Map([...st, ...st2]);
        const chk = await runEngine(uid, 'count', plan.tasks, () => {}, stale(my));
        if (my !== token) return;
        doneView(plan, all, chk);
      } catch (e) { if (my === token) fail(e, () => wipe(plan, counted)); }
    }

    function doneView(plan, st, chk) {
      const left = [...chk.values()].filter(s => s.n > 0), errs = [...st.values()].filter(s => s.err);
      const media = [...st.values()].reduce((a, s) => { for (const k in s.media) a[k] += s.media[k]; return a; }, { cld: 0, r2: 0, failed: 0, skipped: 0 });
      const by = sumBy(st), total = [...st.values()].reduce((a, s) => a + s.n, 0);
      const clean = !left.length && !errs.length;
      const rows = CAT_ORDER.map(id => { const l = by[id]; if (!l) return null; const n = l.reduce((a, s) => a + s.n, 0); return n ? h('li', {}, h('span', { class: 'du-ic sm', html: CAT[id][1] }), h('span', { text: CAT[id][0] }), h('b', { text: fmtN(n) })) : null; }).filter(Boolean);
      const again = h('button', { class: 'glow', type: 'button', text: 'Opnieuw opruimen', onclick: scan });
      const recheck = h('button', { class: 'ghost', type: 'button', text: 'Opnieuw controleren', onclick: scan });
      body.replaceChildren(head(),
        h('div', { class: 'du-warn ' + (clean ? 'ok' : 'bad') }, h('span', { html: clean ? I.check : ADM_IC.alert }), h('div', {},
          h('b', { text: clean ? 'Alles is verwijderd' : 'Bijna klaar: er staat nog iets' }),
          h('p', { text: clean ? `Controle: er is niets meer te vinden van ${shown}. In totaal ${fmtN(total)} documenten en bestanden verwijderd.`
            : 'Bij de controle stond er nog iets in de database of ging er iets fout. Als het account nog ergens is ingelogd, kan het apparaat binnen een uur een aanwezigheidsdocument terugzetten; dan helpt opnieuw opruimen.' }))),
        rows.length ? h('ul', { class: 'du-done' }, rows) : null,
        left.length ? h('div', { class: 'du-left' }, h('b', { text: 'Nog over:' }), h('ul', {}, left.map(s => h('li', { text: `${s.t.label}: ${fmtN(s.n)}` })))) : null,
        errs.length ? h('div', { class: 'du-left' }, h('b', { text: 'Fouten:' }), h('ul', {}, errs.map(s => h('li', { text: `${s.t.label}: ${s.err}` })))) : null,
        (media.cld || media.r2 || media.failed || media.skipped) ? h('p', { class: 'acc-note', text: `Foto’s: ${media.cld + media.r2} verwijderd${media.failed ? `, ${media.failed} mislukt` : ''}${media.skipped ? `, ${media.skipped} bij Cloudinary overgeslagen (geen sleutels in de Worker)` : ''}.` }) : null,
        h('div', { class: 'dlg-actions' }, close, clean ? recheck : again));
      D.afterWipe?.(uid);
    }
    scan();
  }

  /* =====================  Opslag  ===================== */
  function buildStorage() {
    const root = h('div', { class: 'stg' });
    const st = { counts: {}, ext: null, loading: false, err: '' };
    const kpis = h('div', { class: 'stg-kpis' }), usage = h('div'), colls = h('div'), cld = h('div'), clean = h('div'), orphans = h('div'), links = h('div', { class: 'stg-links' });
    const refreshBtn = h('button', { class: 'ghost sm', type: 'button', html: ADM_IC.refresh + '<span>Vernieuwen</span>' });
    const stamp = h('small', { class: 'stg-stamp' });

    const gauge = (label, used, limit, fmt = fmtN, note) => {
      const p = pct(used, limit), tone = p >= 90 ? 'bad' : p >= 70 ? 'warn' : 'ok';
      return h('div', { class: 'gauge ' + tone },
        h('div', { class: 'gauge-h' }, h('span', { text: label }), h('b', { text: `${fmt(used)} / ${fmt(limit)}` })),
        h('div', { class: 'gauge-bar', role: 'img', 'aria-label': `${label}: ${Math.round(p)}%` }, h('i', { style: `width:${Math.max(p, used > 0 ? 1.5 : 0)}%` })),
        h('small', { text: note || `${p < 1 && used > 0 ? '<1' : Math.round(p)}% van het gratis plan` }));
    };

    function paint() {
      const c = st.counts, e = st.ext;
      const totalDocs = Object.entries(c).filter(([k, v]) => v != null && k !== '~channels' && !k.startsWith('~') || k === '~messages' || k === '~channels' || k === '~devices' || k === '~typing' || k === '~reads' || k === '~voice' || k === '~sigs' || k === '~notes')
        .reduce((a, [, v]) => a + (v || 0), 0);
      const est = Object.entries(c).reduce((a, [k, v]) => a + (v || 0) * (AVG[k] || 400), 0);
      const sub = (k) => (c[k] == null ? '…' : fmtN(c[k]));
      const authN = e?.auth?.ok ? fmtN(e.auth.count) + (e.auth.more ? '+' : '') : '…';
      kpis.replaceChildren(
        kpi('Inlogaccounts', authN, 'Firebase Authentication'), kpi('Profielen', sub('users'), 'documenten in users'),
        kpi('Berichten', sub('~messages'), 'DM’s en servers samen'), kpi('Documenten', Object.keys(c).length ? fmtN(totalDocs) : '…', 'in de hele database'),
        kpi('Geschatte grootte', Object.keys(c).length ? '≈ ' + fmtBytes(est) : '…', 'van de 1 GB gratis'));

      // Firebase-gebruik
      const fs = e?.firestore;
      usage.replaceChildren(h('h4', { class: 'adm-h', text: 'Firebase-gebruik vandaag' }),
        !e ? h('p', { class: 'hint', text: 'Laden…' })
          : fs?.ok ? h('div', { class: 'panel stg-card' },
              h('div', { class: 'gauges' }, gauge('Lezen', fs.reads, SPARK.reads), gauge('Schrijven', fs.writes, SPARK.writes), gauge('Verwijderen', fs.deletes, SPARK.deletes),
                gauge('Opslag (schatting)', est, SPARK.bytes, fmtBytes, 'schatting op basis van aantal documenten')),
              h('p', { class: 'stg-note', text: `Sinds de laatste dagreset (middernacht Pacific, ${new Date(fs.since).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })} jouw tijd). Op het Blaze-plan gelden deze grenzen niet, maar kosten ze wel geld boven de gratis hoeveelheid. Metingen lopen een paar minuten achter.` }))
            : h('div', { class: 'panel stg-card' }, h('div', { class: 'du-warn info' }, h('span', { html: ADM_IC.alert }), h('div', {}, h('b', { text: 'Gebruik kan nog niet worden uitgelezen' }),
                h('p', { text: 'Melding van Google: ' + (fs?.reason || 'onbekende reden') + ' (Hoort hier iets over rechten bij? Controleer in IAM of het firebase-adminsdk-account de rol “Monitoring Viewer” heeft en wacht een paar minuten.)' }),
                h('a', { class: 'glow sm', href: 'https://console.cloud.google.com/iam-admin/iam?project=chat-a5794', target: '_blank', rel: 'noopener noreferrer', text: 'Open IAM ↗' }))),
              h('p', { class: 'stg-note', text: 'Tot die tijd kun je het gebruik bekijken in Firebase.' }),
              h('a', { class: 'ghost sm', href: FB + '/usage', target: '_blank', rel: 'noopener noreferrer', text: 'Firebase → Gebruik ↗' })));

      // collecties
      const rows = Object.entries(COLLS).map(([k, l]) => ({ k, l, n: c[k], b: (c[k] || 0) * (AVG[k] || 400) })).filter(r => r.n != null).sort((a, b) => b.b - a.b);
      const max = Math.max(1, ...rows.map(r => r.b));
      colls.replaceChildren(h('h4', { class: 'adm-h', text: 'Database per onderdeel' }),
        h('div', { class: 'panel stg-card' }, rows.length ? h('div', { class: 'bars' }, rows.map(r => h('div', { class: 'bar-row' + (r.n ? '' : ' zero') },
          h('span', { class: 'bar-l' }, r.k.startsWith('~') ? h('span', { class: 'bar-tag', text: 'overal' }) : null, r.l),
          h('div', { class: 'bar-t', role: 'img', 'aria-label': `${r.l}: ${fmtN(r.n)} documenten` }, h('i', { style: `width:${r.n ? Math.max(1.5, pct(r.b, max)) : 0}%` })),
          h('b', { class: 'bar-n', text: fmtN(r.n) }), h('small', { class: 'bar-s', text: r.n ? '≈ ' + fmtBytes(r.b) : '' }),
          r.k.startsWith('~') ? h('span', { class: 'bar-x' }) : h('a', { class: 'bar-x', href: `${FB}/firestore/databases/-default-/data/~2F${r.k}`, target: '_blank', rel: 'noopener noreferrer', title: 'Open in Firebase', 'aria-label': r.l + ' openen in Firebase', html: ADM_IC.ext }))))
          : h('p', { class: 'hint', text: st.loading ? 'Tellen…' : 'Nog niet geteld.' }),
        h('p', { class: 'stg-note', text: 'De grootte is een schatting (gemiddelde documentgrootte × aantal); de echte opslag zie je in Firebase → Gebruik. Een bericht telt mee onder “Berichten”, ook als het in een server staat.' })));

      // Cloudinary
      const cd = e?.cloudinary;
      cld.replaceChildren(h('h4', { class: 'adm-h', text: 'Foto’s (Cloudinary)' }),
        !e ? h('p', { class: 'hint', text: 'Laden…' })
          : cd?.ok ? h('div', { class: 'panel stg-card' }, h('div', { class: 'gauges' },
              cd.credits?.limit ? gauge('Credits deze maand', cd.credits.usage || 0, cd.credits.limit, (n) => fmtN(Math.round(n * 10) / 10), 'opslag, verkeer en bewerkingen samen') : null,
              cd.storage?.usage != null ? h('div', { class: 'gauge' }, h('div', { class: 'gauge-h' }, h('span', { text: 'Opslag' }), h('b', { text: fmtBytes(cd.storage.usage) }))) : null,
              cd.bandwidth?.usage != null ? h('div', { class: 'gauge' }, h('div', { class: 'gauge-h' }, h('span', { text: 'Verkeer' }), h('b', { text: fmtBytes(cd.bandwidth.usage) }))) : null,
              cd.resources != null ? h('div', { class: 'gauge' }, h('div', { class: 'gauge-h' }, h('span', { text: 'Bestanden' }), h('b', { text: fmtN(cd.resources) }))) : null),
              h('p', { class: 'stg-note', text: `Plan: ${cd.plan || 'onbekend'}. Foto’s van een gewist account worden automatisch ook hier verwijderd.` }),
              h('a', { class: 'ghost sm', href: 'https://console.cloudinary.com/', target: '_blank', rel: 'noopener noreferrer', text: 'Cloudinary openen ↗' }))
            : h('div', { class: 'panel stg-card' }, h('div', { class: 'du-warn info' }, h('span', { html: ADM_IC.alert }), h('div', {}, h('b', { text: cd?.reason === 'niet ingesteld' ? 'Cloudinary is nog niet gekoppeld aan de Worker' : 'Cloudinary-gebruik niet beschikbaar' }),
              h('p', { text: cd?.reason === 'niet ingesteld' ? 'Voeg in Cloudflare → je Worker → Settings → Variables drie waarden toe: CLOUDINARY_CLOUD, CLOUDINARY_API_KEY en CLOUDINARY_API_SECRET (Secret). Daarna zie je hier het gebruik en worden foto’s van gewiste accounts ook echt verwijderd.' : String(cd?.reason || '') })))));

      // inlogaccounts zonder profiel
      const have = new Set(D.SUBS.list.map(u => u.uid));
      const lost = e?.auth?.ok && D.SUBS.ready && D.SUBS.list.length < 500 ? e.auth.users.filter(a => !have.has(a.u)) : [];
      orphans.replaceChildren(
        ...(lost.length ? [h('h4', { class: 'adm-h', text: `Inlogaccounts zonder profiel (${lost.length})` }),
          h('div', { class: 'panel stg-card' }, h('p', { class: 'stg-note', text: 'Deze mensen hebben zich geregistreerd maar hebben geen profiel (bijv. de registratie is onderbroken). Ze nemen alleen een inlogaccount in.' }),
            h('div', { class: 'ov-list' }, lost.slice(0, 20).map(a => h('div', { class: 'row orph' },
              h('span', { class: 'item-text' }, h('b', { text: a.e || a.u }), h('small', { text: `aangemaakt ${a.c ? new Date(a.c).toLocaleDateString('nl-NL') : '?'}${a.l ? ' · laatst gezien ' + new Date(a.l).toLocaleDateString('nl-NL') : ''}` })),
              h('button', { class: 'btn-danger sm', type: 'button', text: 'Verwijderen…', onclick: () => openDeleteUser({ uid: a.u, email: a.e }) })))))] : []));
    }
    const kpi = (l, v, s) => h('div', { class: 'stg-kpi' }, h('b', { text: v }), h('span', { text: l }), h('small', { text: s }));

    /* opruimacties */
    const ACTIONS = [
      { id: 'notifs', t: 'Oude meldingen', d: 'Meldingen in de inbox van gebruikers die ouder zijn dan ingesteld. Niemand leest ze nog en ze nemen elke dag ruimte in.', days: [30, 60, 90, 180], def: 60, unit: 'meldingen' },
      { id: 'snaps', t: 'Bekeken streakrs', d: 'Streakrs die al zijn bekeken en niet meer te openen zijn, maar nog als leeg document in de database staan.', unit: 'streakrs' },
      { id: 'spamlog', t: 'Oud spam-logboek', d: 'Regels van de automatische spamdetectie die ouder zijn dan ingesteld. Het moderatielogboek blijft bewaard.', days: [30, 60, 90, 180], def: 90, unit: 'regels' },
      { id: 'orphans', t: 'Weesdocumenten', d: 'Instellingen, aanwezigheid, pushtokens e.d. van accounts die niet meer bestaan. Blijft vaak achter als een account is gewist zonder opruimen.', unit: 'documenten' }
    ];
    function buildClean() {
      clean.replaceChildren(h('h4', { class: 'adm-h', text: 'Opruimen' }), h('div', { class: 'cl-grid' }, ACTIONS.map(a => {
        const sel = a.days ? h('select', { class: 'inp cl-sel', 'aria-label': 'Ouder dan' }, a.days.map(d => h('option', { value: d, text: `ouder dan ${d} dagen` }))) : null;
        if (sel) sel.value = a.def;
        const out = h('p', { class: 'cl-out', role: 'status' }), find = h('button', { class: 'ghost sm', type: 'button', text: 'Zoeken' });
        const go = h('button', { class: 'btn-danger sm', type: 'button', text: 'Opruimen', hidden: true });
        let found = 0;
        const days = () => (sel ? +sel.value : 30);
        find.onclick = async () => {
          find.disabled = true; out.className = 'cl-out'; out.textContent = 'Zoeken…'; go.hidden = true;
          try { const r = await adm({ action: 'maint', task: a.id, days: days(), dry: true }); found = r.n; out.textContent = found ? `${fmtN(found)} ${a.unit} gevonden${r.by ? ' (' + Object.entries(r.by).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(', ') + ')' : ''}.` : 'Niets te ruimen.'; go.hidden = !found; go.textContent = `${fmtN(found)} opruimen`; if (r.note) out.textContent += ' ' + r.note; }
          catch (e) { out.className = 'cl-out err'; out.textContent = e.message; } finally { find.disabled = false; }
        };
        go.onclick = async () => {
          if (!confirm(`${fmtN(found)} ${a.unit} definitief verwijderen?`)) return;
          go.disabled = find.disabled = true; let n = 0;
          try {
            for (let i = 0; i < 400; i++) { const r = await adm({ action: 'maint', task: a.id, days: days(), dry: false }); n += r.n; out.className = 'cl-out'; out.textContent = `Bezig… ${fmtN(n)} verwijderd`; if (!r.more) break; }
            out.className = 'cl-out ok'; out.textContent = `Klaar: ${fmtN(n)} ${a.unit} verwijderd.`; go.hidden = true; toast('Opgeruimd.'); refresh(true);
          } catch (e) { out.className = 'cl-out err'; out.textContent = e.message; } finally { go.disabled = find.disabled = false; }
        };
        return h('div', { class: 'panel cl-card' }, h('div', { class: 'cl-top' }, h('span', { class: 'set-ic', html: ADM_IC.spark }), h('b', { text: a.t })), h('p', { class: 'cl-d', text: a.d }),
          h('div', { class: 'cl-act' }, sel, find, go), out);
      })));
    }

    links.append(...LINKS.map(l => h('a', { class: 'stg-link', href: l.u, target: '_blank', rel: 'noopener noreferrer' }, h('span', { class: 'set-ic', html: ADM_IC[l.ic] }),
      h('span', { class: 'item-text' }, h('b', { text: l.t }), h('small', { text: l.d })), h('span', { class: 'stg-ext', html: ADM_IC.ext }))));

    async function refresh(quiet) {
      if (st.loading) return; st.loading = true; refreshBtn.disabled = true; st.err = '';
      if (!quiet) { st.counts = {}; st.ext = null; }
      paint();
      try {
        const names = Object.keys(COLLS), top = names.filter(n => !n.startsWith('~')), grp = names.filter(n => n.startsWith('~')).map(n => n.slice(1));
        const parts = [{ colls: top.slice(0, 20) }, { colls: top.slice(20), groups: grp }];
        const jobs = parts.map(p => adm({ action: 'usage', ...p }).then(r => { Object.assign(st.counts, r.counts); paint(); }));
        jobs.push(adm({ action: 'external' }).then(r => { st.ext = r; paint(); }));
        await Promise.all(jobs);
        stamp.textContent = 'Bijgewerkt om ' + new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
      } catch (e) {
        st.err = e.message; kpis.replaceChildren(h('div', { class: 'du-warn bad wide' }, h('span', { html: ADM_IC.alert }), h('div', {}, h('b', { text: 'Opslag laden lukte niet' }), h('p', { text: e.message }))));
      } finally { st.loading = false; refreshBtn.disabled = false; if (!st.err) paint(); }
    }
    refreshBtn.onclick = () => refresh(false);
    buildClean(); paint(); refresh(false);
    root.append(h('div', { class: 'stg-top' }, stamp, refreshBtn), kpis, usage, colls, cld, clean, orphans, h('h4', { class: 'adm-h', text: 'Snel naar' }), links);
    stgPaint = paint;
    return root;
  }

  return { buildOverview, paintOverview: () => ovPaint?.(), paintStorage: () => stgPaint?.(), buildLegalEditor, buildStorage, openDeleteUser };
}
