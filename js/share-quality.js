/* =====================  Kwaliteit bij scherm delen (v0.32)  =====================
   Voor je deelt kies je: "Scherp" (minder beelden per seconde, tekst blijft goed leesbaar; dat was het tot nu toe) of
   "Vloeiend" (meer beelden per seconde, wat minder scherp; beter voor games en video). De keuze wordt op dit toestel onthouden.
   Gedeeld door spraakkanalen (voice.js) en bellen (call.js). */
const KEY = 'inf.shareMode';
export const getMode = () => { try { return localStorage.getItem(KEY) === 'smooth' ? 'smooth' : 'sharp'; } catch { return 'sharp'; } };
const setMode = (m) => { try { localStorage.setItem(KEY, m); } catch {} };

export const PROFILES = {
  sharp:  { fps: { ideal: 15, max: 30 }, hint: 'detail', pref: 'maintain-resolution', maxRate: 2500000, total: 5000000 },
  smooth: { fps: { ideal: 60, max: 60 }, hint: 'motion', pref: 'maintain-framerate',  maxRate: 4000000, total: 8000000 }
};
export const profile = (mode) => PROFILES[mode] || PROFILES.sharp;
/** bitrate per verbinding (mesh: je stuurt het naar elke kijker) */
export const rateFor = (mode, viewers) => { const p = profile(mode); return Math.max(400000, Math.min(p.maxRate, Math.floor(p.total / Math.max(1, viewers)))); };
/** stelt de verzender in op deze modus (bitrate en wat de browser opoffert als het te zwaar wordt) */
export async function tuneSender(sender, mode, viewers) {
  if (!sender) return;
  try {
    const pr = sender.getParameters(); pr.encodings = pr.encodings && pr.encodings.length ? pr.encodings : [{}];
    pr.encodings[0].maxBitrate = rateFor(mode, viewers);
    pr.degradationPreference = profile(mode).pref;
    await sender.setParameters(pr);
  } catch {
    try { const pr = sender.getParameters(); pr.encodings = pr.encodings && pr.encodings.length ? pr.encodings : [{}]; pr.encodings[0].maxBitrate = rateFor(mode, viewers); await sender.setParameters(pr); } catch {}
  }
}

/** laat de keuze zien (in het venster waar je klikte, ook het pop-outvenster); geeft 'sharp', 'smooth' of null (geannuleerd) terug */
export function askShareMode(doc = document) {
  return new Promise((resolve) => {
    const d = doc || document, cur = getMode();
    const el = (tag, cls, txt) => { const e = d.createElement(tag); if (cls) e.className = cls; if (txt) e.textContent = txt; return e; };
    const back = el('div', 'shq-back'), box = el('div', 'shq');
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Kwaliteit van je scherm');
    const done = (v) => { d.removeEventListener('keydown', onKey, true); back.remove(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    const opt = (mode, title, sub) => {
      const b = el('button', 'shq-opt' + (cur === mode ? ' cur' : '')); b.type = 'button';
      b.append(el('b', '', title), el('small', '', sub));
      b.onclick = () => { setMode(mode); done(mode); };
      return b;
    };
    const cancel = el('button', 'ghost sm shq-x', 'Annuleren'); cancel.type = 'button'; cancel.onclick = () => done(null);
    box.append(el('h3', '', 'Hoe wil je je scherm delen?'),
      opt('sharp', 'Scherp', 'Minder beelden per seconde, maar tekst en details blijven goed leesbaar. Goed voor presentaties, websites en werk.'),
      opt('smooth', 'Vloeiend', 'Meer beelden per seconde (tot 60), wat minder scherp. Goed voor games en video.'),
      el('small', 'shq-note', 'Het geluid van je scherm (of tabblad) wordt met iedereen in het gesprek gedeeld als je het aanvinkt in het venster van je browser.'), cancel);
    back.append(box); back.addEventListener('click', (e) => { if (e.target === back) done(null); });
    d.addEventListener('keydown', onKey, true);
    d.body.append(back);
    box.querySelector('.cur')?.focus();
  });
}
