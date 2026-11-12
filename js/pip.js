/* =====================  Pop-out venster (v0.21)  =====================
   Zet een stukje van de pagina in een los, altijd-bovenaan venster (Document Picture-in-Picture, Chrome/Edge op de computer).
   Gedeeld door bellen (call.js) en spraakkanalen (voice.js).
   Het venster kan van grootte veranderen (klein = alleen de kaart, groot = met het gedeelde scherm). Chrome staat resizeTo in zo'n venster
   alleen toe na een klik van de gebruiker; daarom meldt size() of het gelukt is, zodat de kaart zo nodig een "Vergroten"-knop kan tonen. */
export const SMALL = { w: 360, h: 100 };
export const BIG = { w: 560, h: 420 };

export function createPip() {
  let win = null, big = false;
  const supported = () => !!(window.documentPictureInPicture && window.documentPictureInPicture.requestWindow);
  const active = () => !!(win && !win.closed);
  const host = () => (active() ? win.document.body : document.body);

  function copyStyles(w) {
    const d = w.document;
    for (const sh of document.styleSheets) {
      try { const st = d.createElement('style'); st.textContent = [...sh.cssRules].map(r => r.cssText).join('\n'); d.head.append(st); }
      catch { if (sh.href) { const l = d.createElement('link'); l.rel = 'stylesheet'; l.href = sh.href; d.head.append(l); } }
    }
    const t = document.documentElement.getAttribute('data-theme'); if (t) d.documentElement.setAttribute('data-theme', t);
    const cs = getComputedStyle(document.body);
    Object.assign(d.body.style, { margin: '0', background: cs.backgroundColor, color: cs.color, fontFamily: cs.fontFamily, overflow: 'hidden' });
  }

  // opent het venster (alleen aanroepen vanuit een klik); onClosed wordt aangeroepen als het venster weer dicht is (ook door de gebruiker)
  async function open(wantBig, onClosed) {
    if (active() || !supported()) return false;
    const sz = wantBig ? BIG : SMALL;
    const w = await window.documentPictureInPicture.requestWindow({ width: sz.w, height: sz.h });
    win = w; big = !!wantBig; copyStyles(w);
    w.addEventListener('pagehide', () => { if (win === w) { win = null; big = false; onClosed?.(); } });
    return true;
  }
  function close() { const w = win; win = null; big = false; try { w?.close(); } catch {} }

  // vraagt een andere grootte; geeft true terug als het venster nu de gewenste grootte heeft
  async function size(wantBig) {
    if (!active()) return false;
    if (wantBig === big) return true;
    const w = win, sz = wantBig ? BIG : SMALL;
    try { w.resizeTo(sz.w, sz.h); } catch {}
    await new Promise(r => setTimeout(r, 150));
    if (win !== w) return false;
    const ok = wantBig ? w.outerWidth >= sz.w - 30 && w.outerHeight >= sz.h - 40 : true;
    if (ok) big = wantBig;
    return ok;
  }
  return { supported, active, host, open, close, size, isBig: () => big };
}
