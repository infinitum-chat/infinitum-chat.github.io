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

/** v0.32: past de kwaliteit van een LOPENDE stream aan. De track en de verzenders blijven dezelfde (geen nieuwe onderhandeling,
    geen replaceTrack), dus kijkers houden hun verbinding en hun beeld loopt gewoon door. Alleen framerate, bitrate en hint veranderen. */
export async function retuneLive(track, senders, mode, viewers) {
  const p = profile(mode);
  try { track.contentHint = p.hint; } catch {}
  try { await track.applyConstraints({ frameRate: p.fps }); } catch {}   // lukt niet overal; de bitrate hieronder werkt altijd
  for (const s of senders) await tuneSender(s, mode, viewers);
}

/** v0.32: wat wordt er nu gedeeld? Een browser laat een pagina geen lijst van vensters of schermen opvragen; dat overzicht is het
    keuzevenster van de browser zelf (zie captureScreen). Wel kan de pagina achteraf zien welke bron gekozen is. */
export function describeSource(track) {
  let ds = '', label = '';
  try { ds = (track.getSettings && track.getSettings().displaySurface) || ''; } catch {}
  try { label = (track.label || '').trim(); } catch {}
  const kind = ds === 'monitor' ? 'Heel scherm' : ds === 'window' ? 'Venster' : ds === 'browser' ? 'Browsertabblad' : 'Scherm';
  // sommige browsers geven alleen een algemene naam ("screen:0:0", "Screen 1"); dan tonen we alleen het soort
  const generic = !label || /^(screen|window|web-contents-media-stream|monitor)\b/i.test(label) || /^screen:\d/i.test(label);
  return { kind, name: generic ? '' : label, text: generic ? kind : kind + ': ' + label };
}

/** opent het keuzevenster van de browser (overzicht van schermen, vensters en tabbladen) en geeft de nieuwe stream terug;
    gooit NotAllowedError/AbortError als de gebruiker annuleert */
export async function captureScreen(mode) {
  const vid = { frameRate: profile(mode).fps };
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video: vid, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false, restrictOwnAudio: true }, systemAudio: 'include' });
  } catch (e1) {
    if (e1 && (e1.name === 'NotAllowedError' || e1.name === 'AbortError')) throw e1;
    return await navigator.mediaDevices.getDisplayMedia({ video: vid, audio: false });   // deze browser kent geen geluid bij scherm delen
  }
}

/** laat de keuze zien (in het venster waar je klikte, ook het pop-outvenster); geeft 'sharp', 'smooth' of null (geannuleerd) terug */
export function askShareMode(doc = document, live = null) {
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
    const cancel = el('button', 'ghost sm shq-x', live ? 'Sluiten' : 'Annuleren'); cancel.type = 'button'; cancel.onclick = () => done(null);
    const now = live && live.getSettings ? describeSource(live) : null;
    const srcBox = now ? el('div', 'shq-src') : null;
    if (srcBox) {
      const sw = el('button', 'ghost sm shq-sw', 'Andere bron kiezen…'); sw.type = 'button'; sw.onclick = () => done('source');
      srcBox.append(el('small', '', 'Je deelt nu'), el('b', '', now.text), sw);
    }
    box.append(el('h3', '', live ? 'Je stream beheren' : 'Hoe wil je je scherm delen?'), ...(srcBox ? [srcBox] : []),
      opt('sharp', 'Scherp', 'Minder beelden per seconde, maar tekst en details blijven goed leesbaar. Goed voor presentaties, websites en werk.'),
      opt('smooth', 'Vloeiend', 'Meer beelden per seconde (tot 60), wat minder scherp. Goed voor games en video.'),
      el('small', 'shq-note', live ? 'Je stream blijft gewoon doorlopen: kijkers houden hun verbinding en zien geen zwart of laadscherm. De browser toont zelf het overzicht van beschikbare schermen, vensters en tabbladen.' : 'Het geluid van je scherm (of tabblad) wordt met iedereen in het gesprek gedeeld als je het aanvinkt in het venster van je browser.'), cancel);
    back.append(box); back.addEventListener('click', (e) => { if (e.target === back) done(null); });
    d.addEventListener('keydown', onKey, true);
    d.body.append(back);
    box.querySelector('.cur')?.focus();
  });
}
