/* =====================  Volume per persoon (v0.22)  =====================
   Zet iemand harder of zachter in een gesprek of spraakkanaal (0 t/m 200%). De keuze wordt per persoon op dit toestel bewaard,
   en werkt alleen voor jou: de ander merkt er niets van. Boven 100% gaat het geluid via een WebAudio-versterker (GainNode);
   kan dat niet, dan werkt de schuif tot 100% via het volume van het audio-element zelf. Er wordt niets naar de server gestuurd. */
const KEY = 'inf.vols';
const MAX = 200;
let ac = null, cache = null;

const load = () => { if (cache) return cache; try { const o = JSON.parse(localStorage.getItem(KEY) || '{}'); cache = o && typeof o === 'object' ? o : {}; } catch { cache = {}; } return cache; };
const save = () => { try { const o = load(), ks = Object.keys(o); if (ks.length > 300) for (const k of ks.slice(0, ks.length - 300)) delete o[k]; localStorage.setItem(KEY, JSON.stringify(o)); } catch {} };
const clamp = (n) => Math.max(0, Math.min(MAX, Math.round(+n)));

export const savedVolume = (uid) => { const v = load()[uid]; return isFinite(v) ? clamp(v) : 100; };
function rememberVolume(uid, pct) { const o = load(); if (pct === 100) delete o[uid]; else o[uid] = pct; save(); }

function context() {
  if (!ac) { try { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ac = new AC(); } catch {} }
  if (ac && ac.state === 'suspended') ac.resume().catch(() => {});
  return ac;
}
// sommige browsers starten de AudioContext pas na een tik/klik
for (const ev of ['pointerdown', 'keydown', 'touchend']) addEventListener(ev, () => { if (ac && ac.state === 'suspended') ac.resume().catch(() => {}); }, { passive: true });

/* Koppelt het geluid van één persoon aan een volume-regelaar.
   audio: het <audio>-element dat de stream afspeelt, uid: van wie het geluid is, stream: de MediaStream.
   Geeft { set(pct), get(), mute(bool), destroy() } terug. */
export function attachVolume(audio, uid, stream) {
  const hd = { pct: savedVolume(uid), muted: false, src: null, gain: null };
  const ctx = context();
  if (ctx) {
    try {
      hd.src = ctx.createMediaStreamSource(stream);
      hd.gain = ctx.createGain();
      hd.src.connect(hd.gain); hd.gain.connect(ctx.destination);
      audio.muted = true;   // het element blijft de stream "vasthouden" (nodig in Chrome), het geluid komt uit de versterker
    } catch { hd.src = hd.gain = null; }
  }
  const apply = () => {
    const g = hd.muted ? 0 : hd.pct / 100;
    if (hd.gain) hd.gain.gain.value = g;
    else { audio.muted = hd.muted || hd.pct === 0; audio.volume = Math.min(1, g); }
  };
  hd.set = (pct, keep = true) => { hd.pct = clamp(pct); if (keep) rememberVolume(uid, hd.pct); apply(); };
  hd.get = () => hd.pct;
  hd.mute = (on) => { hd.muted = !!on; apply(); };
  hd.destroy = () => { try { hd.src?.disconnect(); hd.gain?.disconnect(); } catch {} hd.src = hd.gain = null; };
  apply();
  return hd;
}

/* De schuif zelf. getHandle() levert de regelaar op het moment dat je schuift (die kan er nog niet zijn als de verbinding
   nog opstart: dan wordt alleen de keuze bewaard en toegepast zodra het geluid binnenkomt). */
export function volumeSlider(h, uid, getHandle, opts = {}) {
  const out = h('output', { class: 'vol-val' });
  const inp = h('input', { class: 'vol-range', type: 'range', min: 0, max: MAX, step: 5, 'aria-label': opts.label || 'Volume' });
  const show = (v) => { out.textContent = v + '%'; inp.style.setProperty('--p', (v / MAX * 100) + '%'); inp.classList.toggle('boost', v > 100); };
  const v0 = getHandle()?.get() ?? savedVolume(uid);
  inp.value = v0; show(v0);
  inp.addEventListener('input', () => {
    const v = clamp(inp.value); show(v);
    const hd = getHandle();
    if (hd) hd.set(v); else { rememberVolume(uid, v); }
  });
  inp.addEventListener('dblclick', () => { inp.value = 100; inp.dispatchEvent(new Event('input')); });   // dubbelklik = terug naar normaal
  // de kaart is versleepbaar: een schuif mag dat niet starten
  inp.addEventListener('pointerdown', (e) => e.stopPropagation());
  return h('label', { class: 'vol-row' + (opts.cls ? ' ' + opts.cls : ''), title: 'Dubbelklik om terug te gaan naar 100%' }, opts.icon ? h('i', { class: 'vol-ic', html: opts.icon }) : null, inp, out);
}
