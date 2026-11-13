/* =====================  Bellen (v0.19, alleen Infinitum Prime kan bellen)  =====================
   Spraakoproepen in DM's met WebRTC. Het geluid gaat rechtstreeks van het ene toestel naar het andere (peer-to-peer) en wordt
   nergens opgeslagen. Lukt een directe verbinding niet (streng netwerk, mobiel internet), dan gaat het versleutelde geluid via de gratis
   TURN-server van Cloudflare; ook die bewaart niets en stuurt het alleen door.

   Firestore (gratis plan, zo zuinig mogelijk):
   - calls/{uid van de beller}   { caller, callee, callerName, chatId, status, createdAt, offer{type,sdp}, answer{type,sdp} }
     Maximaal 1 document per beller, dat bij elke nieuwe oproep wordt overschreven en na afloop door de beller wordt gewist.
     status: 'ringing' -> 'accepted' | 'declined' | 'busy' -> 'ended'.  Geen losse ICE-berichten: we wachten tot het toestel zijn
     verbindingsgegevens verzameld heeft en sturen die in één keer mee (offer en answer), dus per oproep maar 2 à 3 schrijfacties.
   - config/features.calls = false zet bellen voor iedereen uit (noodschakelaar, net als typingIndicators).
   Cloudflare Worker (worker.js): POST /turn geeft tijdelijke TURN-gegevens, en een pushmelding 'call' laat een gesloten app overgaan. */
import { db } from './firebase.js?v=0.29';
import { createPip } from './pip.js?v=0.29';
import { attachVolume, volumeSlider } from './volume.js?v=0.29';
import { openMic } from './audio-fx.js?v=0.29';
import {
  collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';

const RING_MS = 45000;          // zo lang gaat het over voordat het "geen gehoor" is
const STALE_MS = 90000;         // een oproep die ouder is dan dit negeren we (kan ook door een afwijkende klok komen)
const GATHER_MS = 3500;         // maximaal zo lang wachten op de verbindingsgegevens van dit toestel
const LOST_MS = 9000;           // verbinding weg? zo lang proberen we te herstellen
const FALLBACK_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];   // gratis STUN; zonder TURN kan het op sommige netwerken niet lukken

const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const IC = {
  phone: svg('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>'),
  hang: svg('<g transform="rotate(135 12 12)"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></g>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  screen: svg('<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  shrink: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  pip: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="12" width="8" height="6" rx="1" fill="currentColor"/>'),
  pipBack: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M14 10l-4 4M10 10v4h4"/>'),
  speaker: svg('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>'),
  micOff: svg('<path d="M3 3l18 18M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.300M5 11a7 7 0 0 0 11.500 5.300M19 11a7 7 0 0 1-.6 2.800M12 18v3"/>')
};

export function createCalls(X) {
  /* X: { h, $, S, avatar, toast, auth, tierAtLeast, askUpgrade, pushPing, isDnd, isBlocked, fbErr } */
  const { h, $, S } = X;
  const state = { enabled: true, started: false, c: null, unsubIn: null, incoming: new Map() };
  let card = null, ringTimer = 0, tone = null;
  const pip = createPip(); let growFailed = false;
  let cardPos = loadCardPos();   // { x, y } in px (links/boven), bewaard op dit toestel

  /* ---------- geluidjes (zelf gemaakt met WebAudio, geen bestanden nodig) ---------- */
  function startTone(kind) {
    stopTone();
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      const ctx = new AC(); ctx.resume?.().catch(() => {});
      const beep = () => {
        const t = ctx.currentTime;
        const notes = kind === 'in' ? [[523, 0], [659, .28]] : [[425, 0]];   // beller hoort een rustige toon, ontvanger een belletje
        for (const [f, d] of notes) {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
          g.gain.setValueAtTime(0, t + d); g.gain.linearRampToValueAtTime(.18, t + d + .03); g.gain.linearRampToValueAtTime(0, t + d + (kind === 'in' ? .26 : 1.0));
          o.start(t + d); o.stop(t + d + (kind === 'in' ? .3 : 1.05));
        }
        if (kind === 'in') try { navigator.vibrate?.([250, 120, 250]); } catch {}
      };
      beep();
      tone = { ctx, iv: setInterval(beep, kind === 'in' ? 1800 : 3000) };
    } catch { tone = null; }
  }
  function stopTone() {
    if (!tone) return;
    clearInterval(tone.iv); try { tone.ctx.close(); } catch {}
    tone = null; try { navigator.vibrate?.(0); } catch {}
  }

  /* ---------- ICE (STUN/TURN) ophalen bij de Worker ---------- */
  async function iceServers(callId) {
    const base = X.workerUrl();
    if (!base) return { list: FALLBACK_ICE, relay: false };
    try {
      const idt = await X.auth.currentUser.getIdToken();
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(base + '/turn' + (callId ? '?call=' + encodeURIComponent(callId) : ''), {
        method: 'POST', headers: { Authorization: 'Bearer ' + idt, 'Content-Type': 'application/json' }, body: '{}', signal: ctl.signal
      });
      clearTimeout(to);
      const j = await r.json().catch(() => null);
      const list = j && j.ok && Array.isArray(j.iceServers) && j.iceServers.length ? j.iceServers : null;
      if (list) return { list, relay: true };
      console.warn('Geen TURN-gegevens van de Worker:', j && j.reason);
    } catch (e) { console.warn('TURN ophalen mislukt:', e); }
    return { list: FALLBACK_ICE, relay: false };
  }

  const gathered = (pc) => new Promise(res => {
    if (pc.iceGatheringState === 'complete') return res();
    const done = () => { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', on); res(); };
    const on = () => { if (pc.iceGatheringState === 'complete') done(); };
    const t = setTimeout(done, GATHER_MS);
    pc.addEventListener('icegatheringstatechange', on);
  });

  // v0.28: de microfoon komt uit audio-fx.js (ruisonderdrukking, gevoeligheid, volume; instelbaar bij Instellingen -> Spraak & geluid)
  async function mic(c) {
    const fx = await openMic();
    c.fx = fx;
    if (fx.note) X.toast(fx.note);
    return fx.stream;
  }

  function makePc(c, list) {
    const pc = new RTCPeerConnection({ iceServers: list, bundlePolicy: 'max-bundle' });
    c.pc = pc;
    for (const t of c.stream.getTracks()) pc.addTrack(t, c.stream);
    // Scherm delen zonder opnieuw te onderhandelen: er is vanaf het begin een (lege) videoverbinding, en het scherm wordt er later
    // alleen ingezet (replaceTrack). Een vast datakanaal (id 0, aan beide kanten hetzelfde) meldt of de ander deelt.
    if (c.role === 'caller') c.vsender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;   // de opnemer gebruikt de videoverbinding uit de oproep (zie accept)
    try {
      const dc = pc.createDataChannel('ctl', { negotiated: true, id: 0 });
      c.dc = dc;
      dc.onopen = () => { if (c.sharing) try { dc.send('share:1'); } catch {} };
      dc.onmessage = (ev) => { if (c === state.c) setRemoteShare(c, ev.data === 'share:1'); };
    } catch {}
    pc.ontrack = (ev) => {
      if (ev.track.kind === 'video') { c.video.srcObject = new MediaStream([ev.track]); c.video.play().catch(() => {}); return; }
      const ms = ev.streams[0] || new MediaStream([ev.track]);
      c.audio.srcObject = ms;
      c.audio.play().catch(() => {});
      c.vol?.destroy(); c.vol = attachVolume(c.audio, c.peer.uid, ms);   // volume van de ander (v0.23)
    };
    pc.onconnectionstatechange = () => {
      if (c !== state.c) return;
      const s = pc.connectionState;
      if (s === 'connected') { clearTimeout(c.lostT); if (!c.t0) { c.t0 = Date.now(); c.tick = setInterval(paintTime, 1000); } setStatus('connected'); }
      else if (s === 'disconnected') { setStatus('lost'); clearTimeout(c.lostT); c.lostT = setTimeout(() => { if (c === state.c && pc.connectionState !== 'connected') over(c, 'De verbinding is verbroken.'); }, LOST_MS); }
      else if (s === 'failed') over(c, c.relay ? 'De verbinding is mislukt.' : 'De verbinding is mislukt. Waarschijnlijk staat de TURN-server nog niet goed ingesteld (zie README).');
    };
    return pc;
  }

  /* ---------- scherm delen ---------- */
  const canShare = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  function setRemoteShare(c, on) {
    c.remoteSharing = !!on;
    if (!on && c.fsBox && document.fullscreenElement === c.fsBox) { try { document.exitFullscreen(); } catch {} }
    if (!on) { try { c.video.pause(); } catch {} }
    else c.video.play().catch(() => {});
    card?.classList.toggle('has-video', c.remoteSharing);
    fitPip();
  }
  async function startShare() {
    const c = state.c; if (!c || c.status !== 'connected' || c.sharing) return;
    if (!c.vsender) return X.toast('Scherm delen kan niet in dit gesprek. Bel opnieuw.');
    let ms;
    try {
      ms = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
    } catch (e) {
      if (e && e.name !== 'NotAllowedError' && e.name !== 'AbortError') X.toast('Scherm delen is niet gelukt.');
      return;
    }
    if (state.c !== c) { ms.getTracks().forEach(t => t.stop()); return; }
    const tr = ms.getVideoTracks()[0];
    try { tr.contentHint = 'detail'; } catch {}
    try {
      await c.vsender.replaceTrack(tr);
      const p = c.vsender.getParameters(); p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
      p.encodings[0].maxBitrate = 2500000; await c.vsender.setParameters(p).catch(() => {});
    } catch (e) { ms.getTracks().forEach(t => t.stop()); return X.toast('Scherm delen is niet gelukt.'); }
    c.screen = ms; c.sharing = true;
    tr.onended = () => { if (c === state.c) stopShare(); };   // de knop "Delen stoppen" van de browser zelf
    try { c.dc?.readyState === 'open' && c.dc.send('share:1'); } catch {}
    paintCard();
  }
  function stopShare() {
    const c = state.c; if (!c || !c.sharing) return;
    c.sharing = false;
    try { c.screen?.getTracks().forEach(t => t.stop()); } catch {} c.screen = null;
    try { c.vsender?.replaceTrack(null); } catch {}
    try { c.dc?.readyState === 'open' && c.dc.send('share:0'); } catch {}
    paintCard();
  }

  /* ---------- venster ---------- */
  function paintTime() {
    const c = state.c; if (!c || !c.t0 || !card) return;
    const s = Math.floor((Date.now() - c.t0) / 1000), el = card.querySelector('.call-st');
    if (el && c.status === 'connected') el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  function setStatus(st, text) {
    const c = state.c; if (!c) return; c.status = st;
    if (!card) return;
    if (st === 'connected' && card.dataset.st !== 'connected' && canShare()) { card.dataset.st = st; paintCard(); return; }
    card.dataset.st = st;
    const el = card.querySelector('.call-st'); if (!el) return;
    el.textContent = text || ({
      calling: 'Bellen…', ringing: 'Gaat over…', incoming: 'Inkomende oproep', connecting: 'Verbinden…',
      lost: 'Verbinding wordt hersteld…', connected: '00:00'
    }[st] || '');
    if (st === 'connected') paintTime();
  }
  /* ---------- verplaatsen en pop-out (v0.23) ---------- */
  function loadCardPos() {
    try { const o = JSON.parse(localStorage.getItem('inf.callCardPos') || 'null'); return o && isFinite(o.x) && isFinite(o.y) ? { x: +o.x, y: +o.y } : null; } catch { return null; }
  }
  function saveCardPos() { try { localStorage.setItem('inf.callCardPos', JSON.stringify(cardPos)); } catch {} }
  function placeCard(el) {
    if (!el || !cardPos || el.classList.contains('in-pip')) return;
    el.style.right = 'auto';
    const w = el.offsetWidth || 340, hh = el.offsetHeight || 70;
    el.style.left = Math.max(6, Math.min(cardPos.x, innerWidth - w - 6)) + 'px';
    el.style.top = Math.max(6, Math.min(cardPos.y, innerHeight - hh - 6)) + 'px';
  }
  // de kaart kun je overal naartoe slepen (muis of vinger); een klein stukje slepen telt nog als gewone klik
  function dragify(el) {
    let st = null, moved = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button > 0 || e.target.closest('.call-acts, .call-vid')) return;
      const r = el.getBoundingClientRect();
      st = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, on: false };
    });
    el.addEventListener('pointermove', (e) => {
      if (!st || e.pointerId !== st.id) return;
      const dx = e.clientX - st.sx, dy = e.clientY - st.sy;
      if (!st.on) { if (Math.hypot(dx, dy) < 6) return; st.on = true; el.classList.add('drag'); try { el.setPointerCapture(e.pointerId); } catch {} }
      cardPos = { x: st.ox + dx, y: st.oy + dy }; placeCard(el);
    });
    const end = (e) => {
      if (!st || e.pointerId !== st.id) return;
      if (st.on) { moved = true; setTimeout(() => { moved = false; }, 0); el.classList.remove('drag'); saveCardPos(); }
      st = null;
    };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); } }, true);
  }
  window.addEventListener('resize', () => placeCard(card));

  // Pop-out: de kaart in een los, altijd-bovenaan venster (zie pip.js). Zodra de ander zijn scherm deelt, wordt het venster groter.
  const canPip = () => pip.supported();
  const host = () => pip.host();
  async function openPip() {
    const c = state.c; if (!c || pip.active() || !canPip()) return;
    try {
      await pip.open(!!c.remoteSharing, () => { growFailed = false; if (state.c) paintCard(); });
      if (state.c !== c) { pip.close(); return; }
      growFailed = false; paintCard();
    } catch (e) {
      if (e && e.name !== 'NotAllowedError' && e.name !== 'AbortError') X.toast('Pop-out openen is niet gelukt.');
    }
  }
  const closePip = () => { pip.close(); growFailed = false; };
  const togglePip = () => (pip.active() ? (closePip(), state.c && paintCard()) : openPip());
  // past de grootte van het venster aan op "wordt er een scherm getoond?"
  async function fitPip() {
    const c = state.c; if (!c || !pip.active()) return;
    const want = !!c.remoteSharing;
    if (want === pip.isBig()) { if (growFailed) { growFailed = false; card?.classList.remove('needs-grow'); } return; }
    const ok = await pip.size(want);
    if (state.c !== c || !pip.active()) return;
    growFailed = !ok; card?.classList.toggle('needs-grow', growFailed);
  }

  const btn = (cls, icon, label, on) => h('button', { class: 'call-b ' + cls, type: 'button', html: icon, title: label, 'aria-label': label, onclick: on });

  function enterFs(c) {
    try {
      if (!c.fsBox) {
        c.fsBox = h('div', { class: 'call-fsbox' });
        c.fsBox.addEventListener('click', (e) => { if (e.target === c.video || e.target === c.fsBox) { try { document.exitFullscreen(); } catch {} } });
        c.fsBox.append(h('button', { class: 'call-fs-x', type: 'button', html: IC.shrink, title: 'Volledig scherm sluiten', 'aria-label': 'Volledig scherm sluiten', onclick: () => { try { document.exitFullscreen(); } catch {} } }));
        document.body.append(c.fsBox);
      }
      if (document.fullscreenElement) document.exitFullscreen(); else c.fsBox.requestFullscreen?.();
    } catch {}
  }
  // in/uit fullscreen: de video en de kaart verhuizen mee
  document.addEventListener('fullscreenchange', () => { if (state.c) paintCard(); });

  function paintCard() {
    card?.remove();
    const c = state.c; if (!c) { card = null; return; }
    const acts = h('div', { class: 'call-acts' });
    if (c.role === 'callee' && c.status === 'incoming') {
      acts.append(btn('no', IC.hang, 'Weigeren', () => decline()), btn('ok', IC.phone, 'Opnemen', () => accept()));
    } else {
      const m = btn('mute' + (c.muted ? ' on' : ''), c.muted ? IC.micOff : IC.mic, c.muted ? 'Microfoon aanzetten' : 'Microfoon dempen', () => {
        c.muted = !c.muted; c.stream?.getAudioTracks().forEach(t => { t.enabled = !c.muted; });
        m.classList.toggle('on', c.muted); m.innerHTML = c.muted ? IC.micOff : IC.mic; m.title = c.muted ? 'Microfoon aanzetten' : 'Microfoon dempen';
      });
      const sh = canShare() && c.status === 'connected'
        ? btn('share' + (c.sharing ? ' on' : ''), IC.screen, c.sharing ? 'Delen stoppen' : 'Scherm delen', () => (c.sharing ? stopShare() : startShare())) : null;
      const pb = canPip() ? btn('pip' + (pip.active() ? ' on' : ''), pip.active() ? IC.pipBack : IC.pip, pip.active() ? 'Terug naar de pagina' : 'Pop-out venster', togglePip) : null;
      const vb = btn('vol' + (c.volOpen ? ' on' : ''), IC.speaker, 'Volume van ' + c.peer.name, () => { c.volOpen = !c.volOpen; vb.classList.toggle('on', c.volOpen); card?.classList.toggle('show-vol', c.volOpen); });
      acts.append(...(sh ? [m, sh] : [m]), vb, ...(pb ? [pb] : []), btn('no', IC.hang, 'Ophangen', () => hangup()));
    }
    // Volledig scherm (v0.24): niet de losse video, maar een eigen vlak waar de kaart (dempen, ophangen…) tijdens fullscreen in verhuist
    const fsOn = !!c.fsBox && document.fullscreenElement === c.fsBox;
    let vwrap = null;
    if (fsOn) { if (c.video.parentNode !== c.fsBox) c.fsBox.prepend(c.video); }
    else {
      vwrap = h('div', { class: 'call-vid', title: 'Klik voor volledig scherm' }, c.video);
      vwrap.onclick = () => enterFs(c);
    }
    const inPip = pip.active();
    const vrow = c.status === 'incoming' ? null : volumeSlider(h, c.peer.uid, () => c.vol, { icon: IC.speaker, label: 'Volume van ' + c.peer.name });
    card = h('div', { class: 'call-card' + (inPip ? ' in-pip' : ' dragable') + (c.remoteSharing ? ' has-video' : '') + (c.volOpen ? ' show-vol' : ''), role: 'dialog', 'aria-label': 'Gesprek', 'data-st': c.status },
      h('div', { class: 'call-av' }, X.avatar(c.peer.uid, c.peer.name, 64, true, true)),
      h('div', { class: 'call-tx' }, h('b', { text: c.peer.name }), h('span', { class: 'call-st' })),
      acts, vrow, vwrap, h('button', { class: 'pip-grow', type: 'button', text: 'Klik om dit venster te vergroten', onclick: () => { growFailed = false; fitPip(); } }));
    if (!inPip) dragify(card);
    else if (growFailed) card.classList.add('needs-grow');
    (fsOn ? c.fsBox : host()).append(card);
    placeCard(card);
    setStatus(c.status);
  }

  /* ---------- opruimen ---------- */
  function cleanup() {
    const c = state.c; state.c = null;
    stopTone(); clearTimeout(ringTimer);
    if (c) {
      clearInterval(c.tick); clearTimeout(c.lostT);
      c.unsub?.();
      try { c.fx ? c.fx.stop() : c.stream?.getTracks().forEach(t => t.stop()); } catch {}
      try { c.screen?.getTracks().forEach(t => t.stop()); } catch {}
      try { c.pc?.close(); } catch {}
      try { if (c.fsBox && document.fullscreenElement === c.fsBox) document.exitFullscreen(); c.video.srcObject = null; c.fsBox?.remove(); c.fsBox = null; } catch {}
      try { c.vol?.destroy(); c.audio.srcObject = null; c.audio.remove(); } catch {}
      try { c.wake?.release?.(); } catch {}
    }
    closePip();
    card?.remove(); card = null;
  }
  // een gesprek dat al is afgebroken terwijl er nog iets aan het opstarten was: microfoon en verbinding alsnog vrijgeven
  function drop(c) {
    try { c.fx ? c.fx.stop() : c.stream?.getTracks().forEach(t => t.stop()); } catch {}
    try { c.pc?.close(); } catch {}
    try { c.audio.remove(); } catch {}
  }
  // beëindigt het gesprek lokaal (met een korte melding) zonder iets naar de ander te sturen
  function over(c, msg) { if (c.role === 'caller') end(msg); else finish(msg); }
  function finish(msg) { const had = !!state.c; cleanup(); if (had && msg) X.toast(msg); }

  /* ---------- bellen (beller) ---------- */
  async function startCall(peerUid, peerName, chatId) {
    if (!state.enabled) return X.toast('Bellen staat op dit moment uit.');
    if (!X.tierAtLeast('prime')) return X.askUpgrade('prime', 'Bellen');
    if (state.c) return X.toast('Je zit al in een gesprek.');
    if (X.inVoice?.()) return X.toast('Verlaat eerst het spraakkanaal waar je in zit.');
    if (!window.RTCPeerConnection) return X.toast('Deze browser kan niet bellen.');
    const me = S.me.uid;
    const c = state.c = { role: 'caller', id: me, peer: { uid: peerUid, name: peerName }, chatId, status: 'calling', muted: false, audio: h('audio', { autoplay: true, playsinline: true }), video: h('video', { autoplay: true, playsinline: true, muted: true }), relay: false };
    document.body.append(c.audio);
    paintCard();
    try {
      c.stream = await mic(c);
      if (state.c !== c) return drop(c);
      const ice = await iceServers(''); c.relay = ice.relay;
      if (state.c !== c) return drop(c);
      const pc = makePc(c, ice.list);
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      if (state.c !== c) return drop(c);
      const offer = { type: pc.localDescription.type, sdp: pc.localDescription.sdp };
      await setDoc(doc(db, 'calls', me), {
        caller: me, callee: peerUid, callerName: String(S.profile?.username || S.me.displayName || 'Iemand').slice(0, 20),
        chatId, status: 'ringing', createdAt: serverTimestamp(), offer
      });
      if (state.c !== c) { deleteDoc(doc(db, 'calls', me)).catch(() => {}); return; }
      setStatus('ringing'); startTone('out');
      X.pushPing({ type: 'call', callId: me });   // gesloten app? dan gaat het toestel van de ander toch over
      ringTimer = setTimeout(() => { if (state.c === c && c.status === 'ringing') { hangup('Geen gehoor.'); } }, RING_MS);
      c.unsub = onSnapshot(doc(db, 'calls', me), async s => {
        if (state.c !== c) return;
        const d = s.data(); if (!d) return;
        if (d.status === 'accepted' && d.answer && !c.answered) {
          c.answered = true; stopTone(); clearTimeout(ringTimer); setStatus('connecting');
          try { await c.pc.setRemoteDescription(d.answer); } catch (e) { hangup('Verbinden mislukt: ' + (e.message || e)); }
        } else if (d.status === 'declined') end(`${peerName} heeft de oproep geweigerd.`);
        else if (d.status === 'busy') end(`${peerName} is bezet of wil niet gestoord worden.`);
        else if (d.status === 'ended') end('Het gesprek is beëindigd.');
      }, () => {});
    } catch (e) {
      const denied = String(e?.code || '').includes('permission-denied');
      finish(denied ? 'Bellen is niet gelukt. Je bent geen Prime-lid meer, of jullie zijn geen vrienden meer (of een van jullie heeft de ander geblokkeerd).' : (e && e.message) || 'Bellen is niet gelukt.');
      if (denied) cleanup();
    }
  }

  // de beller sluit af: document wissen (de ander ziet dat het weg is), dan lokaal opruimen
  function end(msg) { const c = state.c; if (c && c.role === 'caller') deleteDoc(doc(db, 'calls', c.id)).catch(() => {}); finish(msg); }

  async function hangup(msg) {
    const c = state.c; if (!c) return;
    if (c.role === 'caller') return end(msg || (c.status === 'connected' ? 'Gesprek beëindigd.' : ''));
    if (c.status === 'incoming') return decline();
    updateDoc(doc(db, 'calls', c.id), { status: 'ended' }).catch(() => {});
    finish(msg || 'Gesprek beëindigd.');
  }

  /* ---------- opnemen (ontvanger) ---------- */
  function ring(id, d) {
    if (state.c) { updateDoc(doc(db, 'calls', id), { status: 'busy' }).catch(() => {}); return; }
    if (X.isDnd() || X.isBlocked(d.caller)) { updateDoc(doc(db, 'calls', id), { status: 'busy' }).catch(() => {}); return; }
    const c = state.c = { role: 'callee', id, peer: { uid: d.caller, name: d.callerName || 'Iemand' }, chatId: d.chatId, offer: d.offer, status: 'incoming', muted: false, audio: h('audio', { autoplay: true, playsinline: true }), video: h('video', { autoplay: true, playsinline: true, muted: true }), relay: false };
    document.body.append(c.audio);
    paintCard(); startTone('in');
    ringTimer = setTimeout(() => { if (state.c === c && c.status === 'incoming') finish(); }, RING_MS);
    c.unsub = onSnapshot(doc(db, 'calls', id), s => {   // de beller stopt, of iemand anders (ander toestel van jou) neemt op
      if (state.c !== c) return;
      const x = s.data();
      if (!x) return finish(c.status === 'incoming' ? `Gemiste oproep van ${c.peer.name}.` : 'Het gesprek is beëindigd.');
      if (c.status === 'incoming' && x.status !== 'ringing' && !c.accepting) return finish();
      if (x.status === 'ended') finish('Het gesprek is beëindigd.');
    }, () => {});
  }

  async function accept() {
    const c = state.c; if (!c || c.role !== 'callee' || c.status !== 'incoming' || c.accepting) return;
    c.accepting = true; stopTone(); clearTimeout(ringTimer); setStatus('connecting'); paintCard();
    try {
      c.stream = await mic(c);
      if (state.c !== c) return drop(c);
      const ice = await iceServers(c.id); c.relay = ice.relay;
      if (state.c !== c) return drop(c);
      const pc = makePc(c, ice.list);
      await pc.setRemoteDescription(c.offer);
      const vt = pc.getTransceivers().find(t => t.receiver.track.kind === 'video');
      if (vt) { vt.direction = 'sendrecv'; c.vsender = vt.sender; }
      else c.vsender = null;
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      if (state.c !== c) return drop(c);
      await updateDoc(doc(db, 'calls', c.id), { status: 'accepted', answer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
      c.audio.play().catch(() => {});
      try { navigator.wakeLock?.request('screen').then(w => { c.wake = w; }).catch(() => {}); } catch {}
    } catch (e) {
      const denied = String(e?.code || '').includes('permission-denied');
      if (denied) updateDoc(doc(db, 'calls', c.id), { status: 'ended' }).catch(() => {});
      finish(denied ? 'Deze oproep is al beantwoord of gestopt.' : (e && e.message) || 'Opnemen is niet gelukt.');
      if (!denied) updateDoc(doc(db, 'calls', c.id), { status: 'declined' }).catch(() => {});
    }
  }
  function decline() {
    const c = state.c; if (!c) return;
    updateDoc(doc(db, 'calls', c.id), { status: 'declined' }).catch(() => {});
    finish();
  }

  /* ---------- luisteren naar inkomende oproepen ---------- */
  // 1 luisteraar op "oproepen aan mij die nu overgaan": zolang niemand belt kost dit vrijwel niets
  function startListen() {
    if (state.unsubIn || !S.me || !state.enabled) return;
    state.unsubIn = onSnapshot(query(collection(db, 'calls'), where('callee', '==', S.me.uid), where('status', '==', 'ringing')), snap => {
      for (const ch of snap.docChanges()) {
        if (ch.type === 'removed') continue;
        const d = ch.doc.data(), at = d.createdAt?.toMillis?.() || 0;
        if (!at || Math.abs(Date.now() - at) > STALE_MS) continue;
        if (state.c && state.c.id === ch.doc.id) continue;
        ring(ch.doc.id, d);
      }
    }, () => {});
  }
  function stopListen() { state.unsubIn?.(); state.unsubIn = null; }

  /* ---------- knop in de DM-kop ---------- */
  const buttons = new Set();
  function button(peerUid, peerName, chatId) {
    const b = h('button', {
      class: 'icon-btn call-btn', type: 'button', html: IC.phone, title: 'Bellen', 'aria-label': 'Bellen',
      onclick: () => startCall(peerUid, peerName, chatId)
    });
    b.hidden = !state.enabled; buttons.add(b);
    for (const x of buttons) if (!x.isConnected && x !== b) buttons.delete(x);
    return b;
  }

  return {
    button,
    startCall,
    start() { state.started = true; startListen(); },
    stop() { state.started = false; stopListen(); if (state.c) { try { hangup(); } catch { cleanup(); } } cleanup(); },
    // noodschakelaar (config/features.calls)
    setEnabled(on) {
      on = on !== false; if (on === state.enabled) return; state.enabled = on;
      for (const b of buttons) b.hidden = !on;
      if (!on) { stopListen(); if (state.c) hangup('Bellen is door de beheerder uitgezet.'); }
      else if (state.started) startListen();
    },
    inCall: () => !!state.c
  };
}
