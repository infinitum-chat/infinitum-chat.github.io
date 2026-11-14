/* Volledig scherm (v0.29): na 3 seconden niks doen verdwijnen de zwevende kaart, de balk en de knopjes, zodat de stream zo groot
   mogelijk is. Beweeg je de muis, raak je het scherm aan of druk je op een toets, dan komen ze meteen terug.
   Werkt voor het schermenblok (.vr-multi) en het losse gespreksscherm (.call-fsbox): alleen de klasse 'fs-idle' op het fullscreen-element
   wordt gezet, de rest regelt de CSS. */
const IDLE_MS = 3000;
import { fsElement } from './fs.js?v=0.32';
let el = null, timer = 0, dragging = false;

const isTarget = (e) => !!e && (e.classList.contains('vr-multi') || e.classList.contains('call-fsbox'));
const hold = () => dragging || !!el?.querySelector('.call-card.drag, .vr-s-vg:focus-within, .vr-s-vol:active');   // niet verbergen tijdens slepen of volume schuiven

function wake() {
  if (!el) return;
  el.classList.remove('fs-idle');
  clearTimeout(timer);
  timer = setTimeout(sleep, IDLE_MS);
}
function sleep() {
  if (!el) return;
  if (hold()) { timer = setTimeout(sleep, 500); return; }
  el.classList.add('fs-idle');
}
function attach(next) {
  if (el === next) return;
  if (el) el.classList.remove('fs-idle');
  clearTimeout(timer);
  el = next;
  if (el) wake();
}

document.addEventListener('fullscreenchange', () => { const f = fsElement(); attach(isTarget(f) ? f : null); });   // echt of nep-volledig-scherm (zie fs.js)
// een kleine drempel, zodat een trillende muis de knoppen niet de hele tijd terugbrengt
let lx = -1, ly = -1;
document.addEventListener('mousemove', (e) => {
  if (!el) return;
  if (Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly) < 3) return;
  lx = e.clientX; ly = e.clientY; wake();
}, { passive: true });
document.addEventListener('pointerdown', (e) => { if (el) { dragging = !!e.target.closest?.('.call-card'); wake(); } }, { passive: true, capture: true });
document.addEventListener('pointerup', () => { dragging = false; if (el) wake(); }, { passive: true, capture: true });
document.addEventListener('pointercancel', () => { dragging = false; }, { passive: true, capture: true });
document.addEventListener('touchstart', () => { if (el) wake(); }, { passive: true, capture: true });
document.addEventListener('keydown', () => { if (el) wake(); }, { capture: true });
document.addEventListener('wheel', () => { if (el) wake(); }, { passive: true });
