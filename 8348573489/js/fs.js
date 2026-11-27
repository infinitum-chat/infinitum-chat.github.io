/* =====================  Volledig scherm met terugval (v0.31)  =====================
   Gedeeld door spraakkanalen (voice.js), bellen (call.js) en de knoppen die na 3 s verdwijnen (fs-idle.js).

   Echt volledig scherm (element.requestFullscreen) werkt niet overal:
   - iPhone/iPod Safari kent het niet voor gewone elementen (alleen voor <video>, en dan verdwijnen onze knoppen);
   - het pop-outvenster (Document Picture-in-Picture) mag geen volledig scherm.
   Daarom is er een "nep"-volledig scherm: het element krijgt de klasse 'pfs' en vult met CSS het hele scherm (of het hele pop-outvenster).
   De rest van de app hoeft het verschil niet te kennen: er wordt dan een gewoon 'fullscreenchange'-event op het element gestuurd
   (bubbelt), en fsElement()/isFs() geven het goede antwoord. */
let pfsEl = null;

/** het element dat nu in volledig scherm staat in de hoofdpagina (echt of nep), of null */
export const fsElement = () => {
  if (pfsEl && !pfsEl.isConnected) pseudoOff(pfsEl);   // het scherm is weggehaald terwijl het nep-volledig-scherm aanstond: opruimen
  return document.fullscreenElement || pfsEl || null;
};
/** staat dit element in volledig scherm (echt of nep)? Werkt ook voor elementen in het pop-outvenster. */
export const isFs = (el) => !!el && (el.ownerDocument.fullscreenElement === el || el.classList.contains('pfs'));

const note = (el) => { try { el.dispatchEvent(new Event('fullscreenchange', { bubbles: true })); } catch {} };
const coarse = () => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } };
const lockLandscape = () => { try { if (coarse()) screen.orientation?.lock?.('landscape')?.catch?.(() => {}); } catch {} };
const unlockOrientation = () => { try { screen.orientation?.unlock?.(); } catch {} };

function pseudoOn(el) {
  const d = el.ownerDocument;
  if (el.classList.contains('pfs')) return;
  el.classList.add('pfs');
  d.documentElement.classList.add('has-pfs');
  if (d === document) pfsEl = el;
  const onKey = (e) => { if (e.key === 'Escape') pseudoOff(el); };
  el._pfsKey = onKey; d.addEventListener('keydown', onKey);
  note(el);
}
function pseudoOff(el) {
  const d = el.ownerDocument;
  if (!el.classList.contains('pfs')) return;
  el.classList.remove('pfs');
  d.documentElement.classList.remove('has-pfs');
  if (pfsEl === el) pfsEl = null;
  if (el._pfsKey) { d.removeEventListener('keydown', el._pfsKey); el._pfsKey = null; }
  note(el);
}

/** zet volledig scherm aan of uit voor dit element */
export function toggleFs(el) {
  if (!el) return;
  const d = el.ownerDocument;
  if (el.classList.contains('pfs')) return pseudoOff(el);
  if (d.fullscreenElement) { try { d.exitFullscreen(); } catch {} return; }
  const real = d === document && document.fullscreenEnabled && typeof el.requestFullscreen === 'function';
  if (!real) return pseudoOn(el);
  let p;
  try { p = el.requestFullscreen(); } catch { return pseudoOn(el); }
  if (p && p.then) p.then(lockLandscape, () => pseudoOn(el));   // geweigerd? dan toch het nep-volledig-scherm
}
/** sluit volledig scherm voor dit element als het erin staat */
export function exitFs(el) {
  if (!el) return;
  if (el.classList.contains('pfs')) return pseudoOff(el);
  if (el.ownerDocument.fullscreenElement === el) { try { el.ownerDocument.exitFullscreen(); } catch {} }
}
/** sluit welk volledig scherm dan ook in de hoofdpagina */
export function exitAnyFs() {
  if (pfsEl) pseudoOff(pfsEl);
  if (document.fullscreenElement) { try { document.exitFullscreen(); } catch {} }
}

document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) unlockOrientation(); });
