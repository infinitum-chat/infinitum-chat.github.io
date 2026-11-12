/* Infinitum emoji: knop + kiezer (categorieën, zoeken, recent gebruikt) en :shortcode:-aanvulling in de typbalk.
   De emojilijst zelf (js/emoji-data.js, ~130 kB) wordt pas geladen als iemand de kiezer opent of een :code typt. */

const DATA_URL = './emoji-data.js?v=0.23';
const RECENT_KEY = 'infinitum-emoji-recent';
const MAX_RECENT = 32;

const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
export const ICON = {
  emoji: svg('<circle cx="12" cy="12" r="9"/><path d="M8.5 14a4.2 4.2 0 0 0 7 0"/><path d="M9 9.5h.01M15 9.5h.01"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  recent: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  smileys: svg('<circle cx="12" cy="12" r="9"/><path d="M8.5 14a4.2 4.2 0 0 0 7 0"/><path d="M9 9.5h.01M15 9.5h.01"/>'),
  animals: svg('<path d="M12 12c-2.5 0-5 2.8-5 5.2 0 1.8 1.4 2.8 3 2.8.8 0 1.3-.3 2-.3s1.2.3 2 .3c1.6 0 3-1 3-2.8 0-2.4-2.5-5.2-5-5.2z"/><circle cx="6.5" cy="9.5" r="1.5"/><circle cx="10" cy="5.8" r="1.5"/><circle cx="14" cy="5.8" r="1.5"/><circle cx="17.5" cy="9.5" r="1.5"/>'),
  food: svg('<path d="M4 9h12v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M16 11h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3.5v2M12 3.5v2"/>'),
  travel: svg('<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  activities: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c3.2 2.6 3.2 15.4 0 18M12 3c-3.2 2.6-3.2 15.4 0 18"/>'),
  objects: svg('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>'),
  symbols: svg('<path d="M12 20.5s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.8a4.3 4.3 0 0 1 7.5 2.7c0 5.4-7.5 10-7.5 10z"/>'),
  flags: svg('<path d="M5 21V4"/><path d="M5 4h11l-1.8 4 1.8 4H5"/>')
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ---------- gegevens ---------- */
let DB = null, pending = null;
export const emojiReady = () => !!DB;
export function loadEmoji() {
  if (DB) return Promise.resolve(DB);
  if (!pending) {
    pending = import(DATA_URL).then(m => { DB = build(m); return DB; }).catch(e => { pending = null; throw e; });
  }
  return pending;
}
function build(m) {
  const list = [], byCode = new Map(), byChar = new Map(), cats = [];
  for (const [id, label] of m.CATS) {
    const from = list.length;
    for (const ln of m.RAW[id].split('\n')) {
      const [ch, name, kw = '', codes = '', nl = ''] = ln.split('|');
      if (!ch) continue;
      const cs = codes.split(',').filter(Boolean);
      const e = { ch, name, kw, nl, cs, cat: id, i: list.length };
      e.words = (name + ' ' + kw + ' ' + nl).toLowerCase().split(/[^a-z0-9+\-]+/).filter(Boolean);
      list.push(e); byChar.set(ch, e);
      for (const c of cs) if (!byCode.has(c)) byCode.set(c, e);
    }
    cats.push({ id, label, from, to: list.length });
  }
  return { list, byCode, byChar, cats };
}

/* ---------- recent gebruikt ---------- */
const getRecent = () => {
  try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string').slice(0, MAX_RECENT) : []; }
  catch { return []; }
};
const pushRecent = (ch) => {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([ch, ...getRecent().filter(x => x !== ch)].slice(0, MAX_RECENT))); } catch { /* opslag geblokkeerd: geen recent-lijst */ }
};

/* ---------- :code: -> emoji in een tekst (bij het versturen) ---------- */
const SC_TEST = /(?<![A-Za-z0-9]):[A-Za-z0-9_+\-]{1,40}:/;
const SC_ALL = /(?<![A-Za-z0-9]):([A-Za-z0-9_+\-]{1,40}):/g;
export const hasShortcode = (t) => SC_TEST.test(t || '');
export function replaceShortcodes(text) {
  if (!DB || !text || !text.includes(':')) return text;
  // tekst tussen `backticks` (code) blijft ongemoeid
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((p, i) => i % 2 ? p : p.replace(SC_ALL, (m, c) => DB.byCode.get(c.toLowerCase())?.ch || m)).join('');
}

function insertAtCaret(ta, str) {
  const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
  if (ta.maxLength > 0 && ta.value.length - (b - a) + str.length > ta.maxLength) return false;
  ta.setRangeText(str, a, b, 'end');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/* ---------- zoeken in de kiezer ---------- */
function searchAll(q) {
  const terms = q.toLowerCase().trim().replace(/^:|:$/g, '').split(/[\s_]+/).filter(Boolean);
  if (!terms.length) return [];
  const res = [];
  for (const e of DB.list) {
    let score = 0, ok = true;
    for (const t of terms) {
      let s = 99;
      for (const c of e.cs) { if (c === t) { s = Math.min(s, 0); break; } if (c.startsWith(t)) s = Math.min(s, 1); else if (c.includes(t)) s = Math.min(s, 4); }
      for (const w of e.words) { if (w === t) s = Math.min(s, 2); else if (w.startsWith(t)) s = Math.min(s, 3); }
      if (s === 99) { ok = false; break; }
      score += s;
    }
    if (ok) res.push([score, e.i]);
  }
  res.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return res.slice(0, 240).map(r => DB.list[r[1]]);
}

/* ---------- de kiezer (popup naast de typbalk) ---------- */
export function createEmojiPicker({ ta, button, touch = false }) {
  const el = document.createElement('div');
  el.className = 'em-pop'; el.hidden = true;
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Emoji kiezen');
  el.innerHTML =
    `<div class="em-top"><label class="em-search">${ICON.search}<input type="search" class="em-q" name="emoji-zoek" placeholder="Zoek emoji…" aria-label="Zoek emoji" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="search" data-lpignore="true" data-1p-ignore="true" data-form-type="other"></label></div>` +
    `<div class="em-tabs" role="tablist" aria-label="Categorieën"></div>` +
    `<div class="em-scroll"><p class="em-empty">Emoji laden…</p></div>` +
    `<div class="em-foot"><span class="em-pv" aria-hidden="true">🙂</span><span class="em-pn">Kies een emoji</span></div>`;
  const q = el.querySelector('.em-q'), tabs = el.querySelector('.em-tabs'), scroll = el.querySelector('.em-scroll');
  const pv = el.querySelector('.em-pv'), pn = el.querySelector('.em-pn');
  let painted = false, html = '', raf = 0, searchTimer = 0;

  const btn = (e) => `<button type="button" class="em" data-i="${e.i}" title=":${esc(e.cs[0])}:" aria-label="${esc(e.name)}">${e.ch}</button>`;
  const section = (id, label, items) => `<section class="em-sec" data-cat="${id}"><h4>${esc(label)}</h4><div class="em-grid">${items.map(btn).join('')}</div></section>`;

  function paintAll() {
    const recent = getRecent().map(ch => DB.byChar.get(ch)).filter(Boolean);
    const sections = (recent.length ? section('recent', 'Recent gebruikt', recent) : '') +
      html;
    scroll.innerHTML = sections;
    scroll.scrollTop = 0;
    const ids = (recent.length ? [['recent', 'Recent gebruikt']] : []).concat(DB.cats.map(c => [c.id, c.label]));
    tabs.innerHTML = ids.map(([id, label]) => `<button type="button" role="tab" class="em-tab" data-cat="${id}" title="${esc(label)}" aria-label="${esc(label)}">${ICON[id] || ICON.emoji}</button>`).join('');
    tabs.firstElementChild?.classList.add('on');
    tabs.hidden = false;
  }
  function paintSearch(text) {
    const res = searchAll(text);
    tabs.hidden = true;
    scroll.innerHTML = res.length
      ? `<section class="em-sec"><h4>Zoekresultaten</h4><div class="em-grid">${res.map(btn).join('')}</div></section>`
      : `<p class="em-empty">Geen emoji gevonden voor “${esc(text.trim())}”.</p>`;
    scroll.scrollTop = 0;
  }
  function spy() {
    raf = 0;
    if (tabs.hidden) return;
    let cur = null;
    for (const s of scroll.querySelectorAll('.em-sec')) { if (s.offsetTop - scroll.scrollTop <= 12) cur = s.dataset.cat; else break; }
    for (const t of tabs.children) t.classList.toggle('on', t.dataset.cat === cur);
  }

  scroll.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(spy); }, { passive: true });
  scroll.addEventListener('click', (ev) => {
    const b = ev.target.closest('.em'); if (!b || !DB) return;
    pick(DB.list[+b.dataset.i], ev.shiftKey);
  });
  scroll.addEventListener('mouseover', (ev) => {
    const b = ev.target.closest('.em'); if (!b || !DB) return;
    const e = DB.list[+b.dataset.i]; pv.textContent = e.ch; pn.textContent = ':' + e.cs[0] + ':';
  });
  tabs.addEventListener('click', (ev) => {
    const t = ev.target.closest('.em-tab'); if (!t) return;
    const s = scroll.querySelector(`.em-sec[data-cat="${t.dataset.cat}"]`);
    if (s) scroll.scrollTo({ top: s.offsetTop - 2, behavior: 'smooth' });
  });
  q.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { if (!DB) return; q.value.trim() ? paintSearch(q.value) : paintAll(); }, 70);
  });
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); if (!touch) ta.focus(); }
  });

  function pick(e, keep) {
    if (!e || ta.disabled) return;
    if (!insertAtCaret(ta, e.ch)) return;
    pushRecent(e.ch);
    pv.textContent = e.ch; pn.textContent = ':' + e.cs[0] + ':';
    if (!touch && !keep) { close(); ta.focus(); }          // pc: kiezen sluit de popup (Shift ingedrukt = openhouden)
    else if (!touch) ta.focus({ preventScroll: true });
  }

  async function open() {
    if (ta.disabled) return;
    el.hidden = false;
    button?.setAttribute('aria-expanded', 'true'); button?.classList.add('on');
    if (touch) ta.blur();                                   // telefoon: toetsenbord weg, zodat de kiezer ruimte heeft
    try { await loadEmoji(); }
    catch { scroll.innerHTML = '<p class="em-empty">Emoji laden mislukt. Controleer je verbinding en probeer het opnieuw.</p>'; return; }
    if (!html) html = DB.cats.map(c => section(c.id, c.label, DB.list.slice(c.from, c.to))).join('');
    if (el.hidden) return;
    q.value = ''; paintAll(); painted = true;
    if (!touch) q.focus({ preventScroll: true });
  }
  function close() {
    if (el.hidden) return;
    el.hidden = true; clearTimeout(searchTimer);
    button?.setAttribute('aria-expanded', 'false'); button?.classList.remove('on');
  }
  const toggle = () => (el.hidden ? open() : close());

  const onDoc = (ev) => {
    if (!el.isConnected) { document.removeEventListener('pointerdown', onDoc, true); return; }
    if (!el.hidden && !el.contains(ev.target) && !(button && button.contains(ev.target))) close();
  };
  document.addEventListener('pointerdown', onDoc, true);

  return { el, open, close, toggle, isOpen: () => !el.hidden, painted: () => painted };
}

/* ---------- :naam aanvullen + :naam: omzetten tijdens het typen ---------- */
export function attachEmojiSuggest(ta) {
  const pop = document.createElement('div');
  pop.className = 'em-sug'; pop.hidden = true; pop.setAttribute('role', 'listbox');
  let items = [], idx = 0, busy = false;

  const hide = () => { pop.hidden = true; items = []; };
  function paint() {
    pop.innerHTML = items.map((it, i) => `<button type="button" role="option" class="em-opt${i === idx ? ' on' : ''}" data-i="${i}"><span class="em-oc">${it.e.ch}</span><span class="em-on">:${esc(it.code)}:</span></button>`).join('');
    pop.hidden = false;
    pop.querySelector('.em-opt.on')?.scrollIntoView({ block: 'nearest' });
  }
  function find(qs) {
    const pre = [], sub = [], kw = [], seen = new Set();
    for (const e of DB.list) {
      let hit = null, kind = 0;
      for (const c of e.cs) { if (c.startsWith(qs)) { hit = c; kind = 1; break; } }
      if (!hit && qs.length >= 3) for (const c of e.cs) { if (c.includes(qs)) { hit = c; kind = 2; break; } }
      if (!hit && qs.length >= 3 && e.words.some(w => w.startsWith(qs))) { hit = e.cs[0]; kind = 3; }
      if (!hit || seen.has(e)) continue;
      seen.add(e);
      (kind === 1 ? pre : kind === 2 ? sub : kw).push({ e, code: hit });
    }
    pre.sort((a, b) => a.code.length - b.code.length);
    return pre.concat(sub, kw).slice(0, 8);
  }
  function choose(i) {
    const it = items[i]; if (!it) return;
    const caret = ta.selectionStart, before = ta.value.slice(0, caret);
    const m = before.match(/(?<![A-Za-z0-9])(:[A-Za-z0-9_+\-]{2,40})$/); if (!m) { hide(); return; }
    busy = true;
    ta.setRangeText(it.e.ch, caret - m[1].length, caret, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    busy = false; pushRecent(it.e.ch); hide(); ta.focus();
  }
  function update(allowConvert) {
    if (ta.disabled || ta.selectionStart !== ta.selectionEnd) { hide(); return; }
    const caret = ta.selectionStart, before = ta.value.slice(0, caret);
    if (!before.includes(':')) { hide(); return; }
    // :sob: -> 😭 zodra je de sluitende dubbele punt typt
    if (allowConvert) {
      const m = before.match(/(?<![A-Za-z0-9])(:([A-Za-z0-9_+\-]{1,40}):)$/);
      if (m && DB) {
        const e = DB.byCode.get(m[2].toLowerCase());
        if (e) {
          busy = true;
          ta.setRangeText(e.ch, caret - m[1].length, caret, 'end');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          busy = false; pushRecent(e.ch); hide(); return;
        }
      }
    }
    const s = before.match(/(?<![A-Za-z0-9])(:([A-Za-z0-9_+\-]{2,40}))$/);
    if (!s) { hide(); return; }
    if (!DB) { loadEmoji().then(() => { if (ta.isConnected && document.activeElement === ta) update(false); }).catch(() => {}); hide(); return; }
    items = find(s[2].toLowerCase());
    if (!items.length) { hide(); return; }
    idx = 0; paint();
  }

  pop.addEventListener('mousedown', (ev) => { const b = ev.target.closest('.em-opt'); if (!b) return; ev.preventDefault(); choose(+b.dataset.i); });
  ta.addEventListener('input', (ev) => { if (busy) return; update(!String(ev.inputType || '').startsWith('delete')); });
  ta.addEventListener('blur', () => setTimeout(hide, 150));

  function key(e) {
    if (pop.hidden || !items.length || e.isComposing) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { idx = (idx + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; paint(); e.preventDefault(); return true; }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); choose(idx); return true; }
    if (e.key === 'Escape') { hide(); e.preventDefault(); return true; }
    return false;
  }
  return { el: pop, key, hide };
}
