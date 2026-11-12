/* =====================  Spraakkanalen (v0.20)  =====================
   Meerdere mensen praten tegelijk in een spraakkanaal van een server. Het geluid gaat rechtstreeks tussen de toestellen
   (WebRTC, "mesh": iedereen heeft een verbinding met iedereen; daarom maximaal 8 deelnemers). Er wordt niets opgenomen of opgeslagen.
   Lukt een directe verbinding niet, dan gaat het versleutelde geluid via de TURN-server van de Worker (zoals bij bellen).

   Firestore (zo zuinig mogelijk):
   - servers/{sid}/channels/{cid}                 type 'voice', met optioneel userLimit (2 t/m 8) en de gewone rechten (acl):
                                                  view = zien, send = deelnemen en praten, manage = anderen dempen/verwijderen
   - servers/{sid}/channels/{cid}/voice/{uid}     aanwezigheid: { uid, name, at, muted, deaf, sharing, srvMuted }. `at` is een hartslag (elke 40 s);
                                                  wie 100 s niets laat horen telt niet meer mee. Verlaten = document wissen.
   - servers/{sid}/channels/{cid}/sigs/{van_naar} verbindingsgegevens tussen twee deelnemers { from, to, nonce, offer, answer, createdAt }.
                                                  Van elk paar belt degene met de "grootste" uid de ander (zo botsen er nooit twee aanbiedingen);
                                                  de gegevens worden in één keer verstuurd (geen losse ICE-berichten) en bij verlaten gewist.

   Scherm delen (net als bij bellen): elke verbinding heeft vanaf het begin een (lege) videoverbinding; het scherm wordt er later alleen
   ingezet (replaceTrack), dus zonder opnieuw te onderhandelen. `sharing` in het aanwezigheidsdocument meldt wie deelt. */
import { db } from './firebase.js?v=0.27';
import { createPip } from './pip.js?v=0.27';
import { attachVolume, volumeSlider } from './volume.js?v=0.27';
import {
  collection, doc, setDoc, updateDoc, deleteDoc, getDocs, onSnapshot, query, where, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';

const STALE_MS = 100000;       // geen hartslag zo lang = weg
const BEAT_MS = 40000;         // hartslag
const GATHER_MS = 3500;
const LOST_MS = 9000;
const CONNECT_MS = 25000;      // zo lang wachten op een verbinding met één deelnemer
const MAX_USERS = 8;
const MAX_RETRY = 4;
const FALLBACK_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
export const VIC = {
  speaker: svg('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  micOff: svg('<path d="M3 3l18 18M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.300M5 11a7 7 0 0 0 11.500 5.300M19 11a7 7 0 0 1-.6 2.800M12 18v3"/>'),
  head: svg('<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><rect x="2" y="14" width="5" height="7" rx="2"/><rect x="17" y="14" width="5" height="7" rx="2"/>'),
  headOff: svg('<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><rect x="2" y="14" width="5" height="7" rx="2"/><rect x="17" y="14" width="5" height="7" rx="2"/><path d="M3 3l18 18"/>'),
  screen: svg('<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'),
  pip: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="12" width="8" height="6" rx="1" fill="currentColor"/>'),
  pipBack: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M14 10l-4 4M10 10v4h4"/>'),
  kick: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'),
  expand: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/>'),
  volume: svg('<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.500 8.500a5 5 0 0 1 0 7M18.500 5.500a9 9 0 0 1 0 13"/>'),
  volumeOff: svg('<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M22 9l-6 6M16 9l6 6"/>'),
  shrink: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  grid: svg('<rect x="3" y="3" width="8" height="8" rx="1.500"/><rect x="13" y="3" width="8" height="8" rx="1.500"/><rect x="3" y="13" width="8" height="8" rx="1.500"/><rect x="13" y="13" width="8" height="8" rx="1.500"/>'),
  focus: svg('<rect x="3" y="3" width="18" height="12" rx="2"/><rect x="3" y="18" width="5" height="3" rx="1"/><rect x="10" y="18" width="5" height="3" rx="1"/><rect x="17" y="18" width="4" height="3" rx="1"/>'),
  leave: svg('<g transform="rotate(135 12 12)"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></g>')
};

export function createVoice(X) {
  /* X: { h, S, auth, avatar, toast, fbErr, workerUrl, inCall, isDnd, onChange, goTo } */
  const { h, S } = X;
  const state = { enabled: true, cur: null, roster: new Map(), watches: new Map(), want: [], room: null, sweep: 0 };
  const key = (sid, cid) => sid + '/' + cid;
  const presCol = (sid, cid) => collection(db, 'servers', sid, 'channels', cid, 'voice');
  const sigCol = (sid, cid) => collection(db, 'servers', sid, 'channels', cid, 'sigs');
  const myName = () => String(S.profile?.username || S.me?.displayName || 'Iemand').slice(0, 20);

  /* ---------- geluidjes (v0.24) ---------- */
  // Komt iemand het kanaal binnen of gaat iemand weg, dan hoort iedereen in het kanaal een korte toon. Dempen en geluid uitzetten geeft een eigen
  // toon die alleen jij hoort: alles wordt lokaal gemaakt en nooit via de microfoon of de verbinding verstuurd.
  let sfxCtx = null;
  const SFX = { join: [[523, 0], [784, .11]], leave: [[784, 0], [523, .11]], mute: [[440, 0], [330, .09]], unmute: [[330, 0], [440, .09]],
    deaf: [[392, 0], [294, .09], [220, .18]], undeaf: [[220, 0], [294, .09], [392, .18]] };
  function sfx(kind) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext, seq = SFX[kind]; if (!AC || !seq) return;
      if (!sfxCtx || sfxCtx.state === 'closed') sfxCtx = new AC();
      const ctx = sfxCtx; if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const t0 = ctx.currentTime + .01;
      for (const [f, dt] of seq) {
        const o = ctx.createOscillator(), g = ctx.createGain(), t = t0 + dt;
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.16, t + .015); g.gain.exponentialRampToValueAtTime(.0001, t + .16);
        o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + .18);
      }
    } catch {}
  }
  const hearing = (c) => !!c && !c.deaf && c.status === 'connected';   // met geluid uit hoor je ook deze toontjes niet

  /* ---------- wie zit er in welk kanaal ---------- */
  const people = (sid, cid) => {
    const m = state.roster.get(key(sid, cid)); if (!m) return [];
    const now = Date.now();
    return [...m.values()].filter(p => now - p.seen < STALE_MS).sort((a, b) => a.joined - b.joined || a.name.localeCompare(b.name));
  };
  function emit() {
    try { X.onChange?.(); } catch {}
    paintCard();
    if (state.room) { if (state.room.el.isConnected) state.room.paint(); else state.room = null; }
  }
  function applyWatch() {
    const want = new Set(state.want.map(x => key(x.sid, x.cid)));
    if (state.cur) want.add(key(state.cur.sid, state.cur.cid));
    for (const [k, w] of state.watches) if (!want.has(k)) { w.unsub(); state.watches.delete(k); state.roster.delete(k); }
    for (const k of want) {
      if (state.watches.has(k)) continue;
      const [sid, cid] = k.split('/');
      const unsub = onSnapshot(presCol(sid, cid), snap => {
        const old = state.roster.get(k) || new Map(), next = new Map(), now = Date.now();
        for (const d of snap.docs) {
          const v = d.data({ serverTimestamps: 'estimate' }), at = v.at?.toMillis?.() || now, prev = old.get(d.id);
          next.set(d.id, {
            uid: d.id, name: String(v.name || 'Iemand').slice(0, 20), muted: !!v.muted, deaf: !!v.deaf, sharing: !!v.sharing, srvMuted: !!v.srvMuted,
            at, seen: prev && prev.at === at ? prev.seen : now, joined: prev ? prev.joined : at
          });
        }
        const first = !state.roster.has(k), me = S.me?.uid;
        state.roster.set(k, next);
        const cur = state.cur;
        if (!first && cur && key(cur.sid, cur.cid) === k && hearing(cur)) {   // iemand anders erbij of weg in jouw kanaal
          let joined = false, left = false;
          for (const id of next.keys()) if (id !== me && !old.has(id)) joined = true;
          for (const id of old.keys()) if (id !== me && !next.has(id)) left = true;
          if (joined) sfx('join'); else if (left) sfx('leave');
        }
        emit(); if (state.cur && key(state.cur.sid, state.cur.cid) === k) reconcile();
      }, () => { state.roster.set(k, new Map()); emit(); });
      state.watches.set(k, { unsub });
    }
    if (state.watches.size && !state.sweep) state.sweep = setInterval(() => { emit(); reconcile(); }, 20000);
    if (!state.watches.size && state.sweep) { clearInterval(state.sweep); state.sweep = 0; }
  }

  /* ---------- ICE ---------- */
  async function iceServers(sid, cid) {
    const base = X.workerUrl();
    if (!base) return { list: FALLBACK_ICE, relay: false };
    try {
      const idt = await X.auth.currentUser.getIdToken();
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(base + '/turn?vc=' + encodeURIComponent(sid + ':' + cid), {
        method: 'POST', headers: { Authorization: 'Bearer ' + idt, 'Content-Type': 'application/json' }, body: '{}', signal: ctl.signal
      });
      clearTimeout(to);
      const j = await r.json().catch(() => null);
      const list = j && j.ok && Array.isArray(j.iceServers) && j.iceServers.length ? j.iceServers : null;
      if (list) return { list, relay: true };
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
  async function mic() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Deze browser kan niet bellen (geen microfoon-ondersteuning).');
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    } catch (e) {
      const n = e && e.name;
      throw new Error(n === 'NotAllowedError' || n === 'SecurityError' ? 'Geen toegang tot je microfoon. Sta de microfoon toe in je browser- of telefooninstellingen.'
        : n === 'NotFoundError' ? 'Er is geen microfoon gevonden.' : 'De microfoon kon niet worden gestart.');
    }
  }

  /* ---------- deelnemen en verlaten ---------- */
  async function join(sid, cid, meta = {}) {
    if (!state.enabled) return X.toast('Spraakkanalen staan op dit moment uit.');
    if (!window.RTCPeerConnection) return X.toast('Deze browser kan niet bellen.');
    if (X.inCall()) return X.toast('Beëindig eerst je gesprek.');
    if (state.cur && state.cur.sid === sid && state.cur.cid === cid) return;
    if (state.cur) await leave();
    const limit = Math.max(2, Math.min(MAX_USERS, +meta.limit || MAX_USERS));
    const others = people(sid, cid).filter(p => p.uid !== S.me.uid);
    if (others.length >= limit) return X.toast('Dit spraakkanaal zit vol.');
    const c = state.cur = {
      sid, cid, name: meta.name || 'spraak', sname: meta.sname || '', limit, peers: new Map(), retries: {}, muted: false, deaf: false, wasMuted: false, sharing: false, screen: null, watching: null,
      srvMuted: false, status: 'joining', box: h('div', { class: 'voice-audio', hidden: true }), levels: new Map(), speaking: new Set(), selfSeen: false
    };
    document.body.append(c.box);
    paintCard(); emit();
    try {
      c.stream = await mic();
      if (state.cur !== c) return drop(c);
      const ice = await iceServers(sid, cid); c.ice = ice.list; c.relay = ice.relay;
      if (state.cur !== c) return drop(c);
      // oude verbindingsgegevens van vorige keren opruimen (alleen die van of voor jou)
      const me = S.me.uid;
      try {
        const [a, b] = await Promise.all([getDocs(query(sigCol(sid, cid), where('to', '==', me))), getDocs(query(sigCol(sid, cid), where('from', '==', me)))]);
        await Promise.all([...a.docs, ...b.docs].map(d => deleteDoc(d.ref).catch(() => {})));
      } catch {}
      if (state.cur !== c) return drop(c);
      await deleteDoc(doc(presCol(sid, cid), me)).catch(() => {});   // een oud document van een eerdere sessie opruimen
      await setDoc(doc(presCol(sid, cid), me), { uid: me, name: myName(), at: serverTimestamp(), muted: false, deaf: false, sharing: false });
      if (state.cur !== c) { deleteDoc(doc(presCol(sid, cid), me)).catch(() => {}); return drop(c); }
      c.status = 'connected';
      try { const AC = window.AudioContext || window.webkitAudioContext; if (AC) { c.ac = new AC(); c.ac.resume?.().catch(() => {}); } } catch {}
      watchLevel(c, me, c.stream);
      c.lvl = setInterval(() => levelTick(c), 140);
      c.hb = setInterval(async () => {
        try { await updateDoc(doc(presCol(sid, cid), me), { at: serverTimestamp() }); }
        catch (e) { if (String(e?.code || '').includes('permission-denied') || String(e?.code || '').includes('not-found')) leave('Je zit niet meer in het spraakkanaal.', true); }
      }, BEAT_MS);
      c.unsubTo = onSnapshot(query(sigCol(sid, cid), where('to', '==', me)), snap => {
        for (const ch of snap.docChanges()) if (ch.type !== 'removed') onOffer(c, ch.doc);
      }, () => {});
      c.unsubFrom = onSnapshot(query(sigCol(sid, cid), where('from', '==', me)), snap => {
        for (const ch of snap.docChanges()) if (ch.type !== 'removed') onAnswer(c, ch.doc);
      }, () => {});
      applyWatch(); paintCard(); emit(); reconcile();
      if (hearing(c)) sfx('join');
      try { navigator.wakeLock?.request('screen').then(w => { c.wake = w; }).catch(() => {}); } catch {}
    } catch (e) {
      const denied = String(e?.code || '').includes('permission-denied');
      const msg = denied ? 'Je mag dit spraakkanaal niet betreden.' : (e && e.message) || 'Deelnemen is niet gelukt.';
      if (state.cur === c) cleanup(c);
      X.toast(msg);
    }
  }
  function drop(c) {
    try { c.stream?.getTracks().forEach(t => t.stop()); } catch {}
    try { c.box.remove(); } catch {}
  }
  async function leave(msg, silent) {
    const c = state.cur; if (!c) return;
    if (hearing(c)) sfx('leave');
    c.closing = true;
    const me = S.me?.uid;
    if (me && !silent) {
      const jobs = [deleteDoc(doc(presCol(c.sid, c.cid), me)).catch(() => {})];
      for (const uid of c.peers.keys()) {
        jobs.push(deleteDoc(doc(sigCol(c.sid, c.cid), me + '_' + uid)).catch(() => {}), deleteDoc(doc(sigCol(c.sid, c.cid), uid + '_' + me)).catch(() => {}));
      }
      Promise.all(jobs);
    } else if (me) deleteDoc(doc(presCol(c.sid, c.cid), me)).catch(() => {});
    cleanup(c);
    if (msg) X.toast(msg);
  }
  function cleanup(c) {
    if (state.cur === c) state.cur = null;
    clearInterval(c.hb); clearInterval(c.lvl);
    c.unsubTo?.(); c.unsubFrom?.();
    for (const uid of [...c.peers.keys()]) dropPeer(c, uid);
    try { c.stream?.getTracks().forEach(t => t.stop()); } catch {}
    try { c.screen?.getTracks().forEach(t => t.stop()); } catch {}
    try { c.ac?.close(); } catch {}
    try { c.box.remove(); } catch {}
    try { c.wake?.release?.(); } catch {}
    applyWatch(); paintCard(); emit();
  }

  /* ---------- verbindingen met de andere deelnemers ---------- */
  function reconcile() {
    const c = state.cur; if (!c || c.closing || c.status !== 'connected') return;
    const me = S.me.uid, k = key(c.sid, c.cid), raw = state.roster.get(k);
    if (!raw) return;
    const mine = raw.get(me);
    if (mine) { c.selfSeen = true; c.srvMuted = !!mine.srvMuted; applyTracks(c); }
    else if (c.selfSeen) { leave('Je bent uit het spraakkanaal gezet.', true); return; }
    const ids = new Set(people(c.sid, c.cid).filter(p => p.uid !== me).map(p => p.uid));
    for (const uid of [...c.peers.keys()]) if (!ids.has(uid)) dropPeer(c, uid);
    for (const uid of ids) if (!c.peers.has(uid) && me > uid && (c.retries[uid] || 0) <= MAX_RETRY) startOffer(c, uid);
  }
  function newPeer(c, uid, nonce, role) {
    const pc = new RTCPeerConnection({ iceServers: c.ice, bundlePolicy: 'max-bundle' });
    const audio = h('audio', { autoplay: true, playsinline: true }); audio.muted = c.deaf; c.box.append(audio);
    const video = h('video', { autoplay: true, playsinline: true, muted: true });
    const saudio = h('audio', { autoplay: true, playsinline: true }); c.box.append(saudio);   // geluid van het gedeelde scherm (v0.27)
    const p = { uid, pc, nonce, audio, video, saudio, vsender: null, asender: null, remoteVideo: false, connected: false };
    for (const t of c.stream.getTracks()) pc.addTrack(t, c.stream);
    // de beller (offer) maakt de videoverbinding aan, de ander gebruikt die na het binnenkomen van het aanbod (zie onOffer)
    if (role === 'offer') {
      p.vsender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
      p.asender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;   // tweede audiospoor: alleen het geluid van het gedeelde scherm (de microfoon is het eerste)
    }
    pc.ontrack = (ev) => {
      if (ev.track.kind === 'video') {
        p.remoteVideo = true; video.srcObject = new MediaStream([ev.track]); video.play().catch(() => {});
        paintCard(); if (state.room) state.room.paint();
        return;
      }
      // het tweede audiospoor is het geluid van het gedeelde scherm, het eerste is de microfoon
      if (ev.transceiver && pc.getTransceivers().filter(t => t.receiver.track.kind === 'audio').indexOf(ev.transceiver) === 1) {
        saudio.srcObject = new MediaStream([ev.track]); shareAudio(c, p); saudio.play().catch(() => {});
        return;
      }
      const ms = ev.streams[0] || new MediaStream([ev.track]);
      audio.srcObject = ms; audio.play().catch(() => {});
      p.vol?.destroy(); p.vol = attachVolume(audio, uid, ms); p.vol.mute(c.deaf);   // volume per persoon (v0.23)
      watchLevel(c, uid, ms);
    };
    pc.onconnectionstatechange = () => {
      if (c.peers.get(uid) !== p) return;
      const s = pc.connectionState;
      if (s === 'connected') { p.connected = true; clearTimeout(p.lostT); clearTimeout(p.connT); c.retries[uid] = 0; paintCard(); }
      else if (s === 'disconnected') { clearTimeout(p.lostT); p.lostT = setTimeout(() => { if (c.peers.get(uid) === p && pc.connectionState !== 'connected') failPeer(c, uid); }, LOST_MS); }
      else if (s === 'failed') failPeer(c, uid);
    };
    p.connT = setTimeout(() => { if (c.peers.get(uid) === p && !p.connected) failPeer(c, uid); }, CONNECT_MS);
    c.peers.set(uid, p);
    return p;
  }
  function dropPeer(c, uid) {
    const p = c.peers.get(uid); if (!p) return;
    c.peers.delete(uid); clearTimeout(p.lostT); clearTimeout(p.connT);
    try { p.pc.close(); } catch {}
    try { p.vol?.destroy(); p.audio.srcObject = null; p.audio.remove(); } catch {}
    try { p.video.srcObject = null; p.video.remove(); } catch {}
    try { p.saudio.srcObject = null; p.saudio.remove(); } catch {}
    if (c.watching === uid) c.watching = null;
    c.levels.delete(uid); c.speaking.delete(uid);
  }
  function failPeer(c, uid) {
    const p = c.peers.get(uid); if (!p || c.closing) return;
    dropPeer(c, uid);
    c.retries[uid] = (c.retries[uid] || 0) + 1;
    if (c.retries[uid] > MAX_RETRY) { X.toast('De verbinding met een deelnemer is mislukt.'); return; }
    setTimeout(() => { if (state.cur === c) reconcile(); }, 2000 + c.retries[uid] * 1500);
  }
  async function startOffer(c, uid) {
    const me = S.me.uid, nonce = Math.random().toString(36).slice(2, 12);
    const p = newPeer(c, uid, nonce, 'offer');
    try {
      await attachShare(c, p);
      await p.pc.setLocalDescription(await p.pc.createOffer());
      await gathered(p.pc);
      if (c.peers.get(uid) !== p) return;
      await setDoc(doc(sigCol(c.sid, c.cid), me + '_' + uid), {
        from: me, to: uid, nonce, offer: { type: p.pc.localDescription.type, sdp: p.pc.localDescription.sdp }, createdAt: serverTimestamp()
      });
    } catch (e) { if (c.peers.get(uid) === p) failPeer(c, uid); }
  }
  async function onAnswer(c, d) {
    if (state.cur !== c) return;
    const v = d.data(), p = c.peers.get(v.to);
    if (!p || !v.answer || v.nonce !== p.nonce || p.answered) return;
    p.answered = true;
    try { await p.pc.setRemoteDescription(v.answer); } catch { failPeer(c, v.to); }
  }
  async function onOffer(c, d) {
    if (state.cur !== c) return;
    const v = d.data(); if (!v.offer || v.answer || !v.from) return;
    const old = c.peers.get(v.from);
    if (old && old.nonce === v.nonce) return;
    if (old) dropPeer(c, v.from);
    const p = newPeer(c, v.from, v.nonce, 'answer');
    try {
      await p.pc.setRemoteDescription(v.offer);
      const vt = p.pc.getTransceivers().find(t => t.receiver.track.kind === 'video');
      if (vt) { vt.direction = 'sendrecv'; p.vsender = vt.sender; }
      const at = p.pc.getTransceivers().filter(t => t.receiver.track.kind === 'audio')[1];
      if (at) { at.direction = 'sendrecv'; p.asender = at.sender; }
      await attachShare(c, p);
      await p.pc.setLocalDescription(await p.pc.createAnswer());
      await gathered(p.pc);
      if (c.peers.get(v.from) !== p) return;
      await updateDoc(d.ref, { answer: { type: p.pc.localDescription.type, sdp: p.pc.localDescription.sdp } });
    } catch (e) { if (c.peers.get(v.from) === p) failPeer(c, v.from); }
  }

  /* ---------- microfoon, hoofdtelefoon en wie er praat ---------- */
  function applyTracks(c) {
    const on = !c.muted && !c.srvMuted;
    c.stream?.getAudioTracks().forEach(t => { t.enabled = on; });
    for (const p of c.peers.values()) { if (p.vol) p.vol.mute(c.deaf); else p.audio.muted = c.deaf; shareAudio(c, p); }
  }
  // geluid van een gedeeld scherm: uit als je op doof staat, als je het geluid van die stream uitzette, of als je dat scherm verborgen hebt
  const sMuted = (c) => c.sMuted || (c.sMuted = new Set());
  function shareAudio(c, p) { try { p.saudio.muted = !!(c.deaf || sMuted(c).has(p.uid) || (c.hidden && c.hidden.has(p.uid))); } catch {} }
  async function pushState(c) {
    try { await updateDoc(doc(presCol(c.sid, c.cid), S.me.uid), { muted: c.muted, deaf: c.deaf, sharing: !!c.sharing, at: serverTimestamp() }); } catch {}
  }
  function toggleMute() {
    const c = state.cur; if (!c) return;
    if (c.srvMuted) return X.toast('Een moderator heeft je gedempt.');
    if (c.deaf) { c.deaf = false; c.muted = false; sfx('undeaf'); } else { c.muted = !c.muted; sfx(c.muted ? 'mute' : 'unmute'); }
    applyTracks(c); pushState(c); paintCard(); emit();
  }
  function toggleDeaf() {
    const c = state.cur; if (!c) return;
    c.deaf = !c.deaf;
    if (c.deaf) { c.wasMuted = c.muted; c.muted = true; } else c.muted = c.wasMuted;
    sfx(c.deaf ? 'deaf' : 'undeaf');
    applyTracks(c); pushState(c); paintCard(); emit();
  }
  function watchLevel(c, uid, stream) {
    if (!c.ac) return;
    try {
      const an = c.ac.createAnalyser(); an.fftSize = 256;
      c.ac.createMediaStreamSource(stream).connect(an);
      c.levels.set(uid, { an, buf: new Uint8Array(an.fftSize) });
    } catch {}
  }
  function levelTick(c) {
    if (state.cur !== c) return;
    let changed = false;
    for (const [uid, l] of c.levels) {
      l.an.getByteTimeDomainData(l.buf);
      let max = 0; for (let i = 0; i < l.buf.length; i++) max = Math.max(max, Math.abs(l.buf[i] - 128));
      let on = max > 9;
      if (uid === S.me.uid && (c.muted || c.srvMuted)) on = false;
      if (on) l.hold = 6; else if (l.hold > 0) { l.hold--; on = true; }
      if (on !== c.speaking.has(uid)) { on ? c.speaking.add(uid) : c.speaking.delete(uid); changed = true; }
    }
    if (changed) for (const el of document.querySelectorAll('[data-vuid]')) el.classList.toggle('speaking', c.speaking.has(el.dataset.vuid) && el.dataset.vcid === c.sid + '/' + c.cid);
  }

  /* ---------- scherm delen ---------- */
  const canShare = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  // iedereen krijgt hetzelfde beeld; hoe meer kijkers, hoe lager de bitrate per verbinding (mesh: je stuurt het naar elke deelnemer)
  async function tuneShare(c) {
    const n = Math.max(1, c.peers.size), rate = Math.max(400000, Math.min(2500000, Math.floor(5000000 / n)));
    for (const p of c.peers.values()) {
      if (!p.vsender) continue;
      try { const pr = p.vsender.getParameters(); pr.encodings = pr.encodings && pr.encodings.length ? pr.encodings : [{}]; pr.encodings[0].maxBitrate = rate; await p.vsender.setParameters(pr); } catch {}
    }
  }
  // zet het scherm (als je deelt) op de videoverbinding van een nieuwe deelnemer
  async function attachShare(c, p) {
    if (!c.sharing || !c.screen || !p.vsender) return;
    try { await p.vsender.replaceTrack(c.screen.getVideoTracks()[0]); } catch {}
    const at = c.screen.getAudioTracks()[0];
    if (at && p.asender) { try { await p.asender.replaceTrack(at); } catch {} }
    tuneShare(c);
  }
  async function startShare() {
    const c = state.cur; if (!c || c.status !== 'connected' || c.sharing) return;
    if (!canShare()) return X.toast('Scherm delen kan niet in deze browser.');
    let ms;
    try {
      const vid = { frameRate: { ideal: 15, max: 30 } };
      try {
        ms = await navigator.mediaDevices.getDisplayMedia({ video: vid, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: true } });
      } catch (e1) {
        if (e1 && (e1.name === 'NotAllowedError' || e1.name === 'AbortError')) throw e1;
        ms = await navigator.mediaDevices.getDisplayMedia({ video: vid, audio: false });   // deze browser kent geen geluid bij scherm delen
      }
    } catch (e) {
      if (e && e.name !== 'NotAllowedError' && e.name !== 'AbortError') X.toast('Scherm delen is niet gelukt.');
      return;
    }
    if (state.cur !== c) { ms.getTracks().forEach(t => t.stop()); return; }
    const tr = ms.getVideoTracks()[0];
    try { tr.contentHint = 'detail'; } catch {}
    c.screen = ms; c.sharing = true;
    tr.onended = () => { if (state.cur === c) stopShare(); };   // de knop "Delen stoppen" van de browser zelf
    const at = ms.getAudioTracks()[0];
    for (const p of c.peers.values()) {
      if (p.vsender) { try { await p.vsender.replaceTrack(tr); } catch {} }
      if (at && p.asender) { try { await p.asender.replaceTrack(at); } catch {} }
    }
    if (!at) X.toast('Je deelt zonder geluid. Kies een tabblad (of heel scherm) en vink "geluid delen" aan om ook het geluid te delen.');
    tuneShare(c);
    pushState(c); paintCard(); emit();
  }
  function stopShare() {
    const c = state.cur; if (!c || !c.sharing) return;
    c.sharing = false;
    try { c.screen?.getTracks().forEach(t => t.stop()); } catch {} c.screen = null;
    for (const p of c.peers.values()) { try { p.vsender?.replaceTrack(null); } catch {} try { p.asender?.replaceTrack(null); } catch {} }
    pushState(c); paintCard(); emit();
  }
  const sharers = (c) => people(c.sid, c.cid).filter(p => p.sharing && p.uid !== S.me.uid && c.peers.get(p.uid)?.remoteVideo);

  /* ---------- moderatie ---------- */
  const modMute = (sid, cid, uid, on) => updateDoc(doc(presCol(sid, cid), uid), { srvMuted: !!on });
  const modKick = (sid, cid, uid) => deleteDoc(doc(presCol(sid, cid), uid));

  /* ---------- zwevend venster ---------- */
  let card = null, cardPos = loadCardPos();   // cardPos: { x, y } in px (links/boven), bewaard op dit toestel
  function loadCardPos() {
    try { const o = JSON.parse(localStorage.getItem('inf.voiceCardPos') || 'null'); return o && isFinite(o.x) && isFinite(o.y) ? { x: +o.x, y: +o.y } : null; } catch { return null; }
  }
  function saveCardPos() { try { localStorage.setItem('inf.voiceCardPos', JSON.stringify(cardPos)); } catch {} }
  function placeCard(el) {
    if (!el || !cardPos || el.classList.contains('in-pip')) return;
    el.style.width = 'min(340px, calc(100vw - 24px))'; el.style.right = 'auto';
    const w = el.offsetWidth || 340, hh = el.offsetHeight || 70;
    el.style.left = Math.max(6, Math.min(cardPos.x, innerWidth - w - 6)) + 'px';
    el.style.top = Math.max(6, Math.min(cardPos.y, innerHeight - hh - 6)) + 'px';
  }
  // de kaart kun je overal naartoe slepen (muis of vinger); een klein stukje slepen telt nog als gewone klik
  function dragify(el) {
    let st = null, moved = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button > 0 || e.target.closest('.call-acts')) return;
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
  // in/uit fullscreen: de kaart verhuist mee naar het schermenblok (of terug naar de pagina)
  document.addEventListener('fullscreenchange', () => { if (state.cur) paintCard(); });
  /* ---------- meerdere schermen tegelijk kijken (v0.23) ---------- */
  // Eén blok voor alle schermen die iemand deelt, gebruikt door de kanaalpagina en het pop-outvenster.
  // Raster: alle schermen naast/onder elkaar (past zich aan aan de breedte). Focus: één groot scherm met de rest als strook eronder.
  // Klik op een scherm om het groot te zien; klik op het grote scherm (of op de knop) voor volledig scherm.
  // Volledig scherm (v0.24): het hele blok gaat op volledig scherm, dus je ziet alle schermen tegelijk, en de verplaatsbare kaart
  // (dempen, geluid, verlaten) wordt tijdens fullscreen in dit blok gezet (zie fsHost/paintCard), zodat je hem nog kunt gebruiken.
  // alle open schermenblokken (pagina en pop-outvenster): een wijziging in het ene blok wordt ook in het andere getoond
  const blocks = new Set();
  function redrawAll() { for (const b of [...blocks]) { if (!b.root.isConnected) { blocks.delete(b); continue; } b.draw(); } }
  function mirrorVideo(pr) {
    const v = h('video', { autoplay: true, playsinline: true, muted: true }); v.muted = true; v.srcObject = pr.video.srcObject;
    return v;
  }
  function streamBlock(c, list0, repaint, compact, mirror) {
    let list = list0;
    const doc_ = () => root.ownerDocument;
    const isFs = () => doc_().fullscreenElement === root;
    const fs = () => { try { if (doc_().fullscreenElement) doc_().exitFullscreen(); else root.requestFullscreen?.(); } catch {} };
    const content = h('div', { class: 'vr-content' });
    const root = h('div', { class: 'vr-multi' }, content);
    const draw = () => {
      const hid = c.hidden || (c.hidden = new Set());
      for (const u of [...hid]) if (!list.some(p => p.uid === u)) hid.delete(u);   // wie stopt met delen is weer zichtbaar als hij opnieuw deelt
      const all = list, shown = all.filter(p => !hid.has(p.uid)), hiddenL = all.filter(p => hid.has(p.uid));
      const multi = shown.length > 1, inFs = isFs();
      if (shown.length && !shown.some(p => p.uid === c.watching)) c.watching = shown[0].uid;
      const focus = multi && c.layout === 'focus';
      const tile = (p) => {
        const pr = c.peers.get(p.uid), big = focus && p.uid === c.watching, sOn = !sMuted(c).has(p.uid);
        const vid = mirror ? mirrorVideo(pr) : pr.video;   // naast het pop-outvenster: een tweede videovenster met hetzelfde beeld
        const cap = h('div', { class: 'vr-s-cap' }, h('span', { class: 'vr-s-n', text: p.name }),
          h('button', { class: 'vr-s-b', type: 'button', html: VIC.eyeOff, title: 'Scherm van ' + p.name + ' verbergen', 'aria-label': 'Scherm van ' + p.name + ' verbergen',
            onclick: (e) => { e.stopPropagation(); hid.add(p.uid); if (pr) shareAudio(c, pr); redrawAll(); } }),
          h('button', { class: 'vr-s-b' + (sOn ? '' : ' off'), type: 'button', html: sOn ? VIC.volume : VIC.volumeOff, 'aria-pressed': !sOn,
            title: 'Geluid van de stream van ' + p.name + (sOn ? ' uitzetten' : ' aanzetten'), 'aria-label': 'Geluid van de stream van ' + p.name + (sOn ? ' uitzetten' : ' aanzetten'),
            onclick: (e) => { e.stopPropagation(); const sm = sMuted(c); if (sm.has(p.uid)) sm.delete(p.uid); else sm.add(p.uid); if (pr) shareAudio(c, pr); redrawAll(); } }),
          h('button', { class: 'vr-s-b', type: 'button', html: inFs ? VIC.shrink : VIC.expand, title: inFs ? 'Volledig scherm sluiten' : 'Alle schermen op volledig scherm', 'aria-label': inFs ? 'Volledig scherm sluiten' : 'Alle schermen op volledig scherm',
            onclick: (e) => { e.stopPropagation(); fs(); } }));
        const go = () => { if (multi && !big) { c.layout = 'focus'; c.watching = p.uid; redrawAll(); } else fs(); };
        const el = h('div', { class: 'vr-s' + (big ? ' big' : ''), 'data-uid': p.uid, tabindex: 0, role: 'button',
          'aria-label': multi && !big ? 'Scherm van ' + p.name + ' groot tonen' : 'Scherm van ' + p.name + (inFs ? ' sluiten' : ' op volledig scherm'),
          title: multi && !big ? 'Klik om groot te tonen' : inFs ? 'Klik om volledig scherm te sluiten' : 'Klik voor volledig scherm' }, vid, cap);
        el.addEventListener('click', go);
        el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); go(); } });
        vid.play().catch(() => {});
        return el;
      };
      const seg = (mode, label, icon) => h('button', { class: 'ghost sm' + ((focus ? 'focus' : 'grid') === mode ? ' on' : ''), type: 'button', 'aria-pressed': (focus ? 'focus' : 'grid') === mode,
        html: icon + '<span>' + label + '</span>', onclick: () => { c.layout = mode; redrawAll(); } });
      const fsb = h('button', { class: 'ghost sm vr-fsb', type: 'button', html: (inFs ? VIC.shrink : VIC.expand) + '<span>' + (inFs ? 'Sluiten' : 'Volledig scherm') + '</span>', onclick: fs });
      const chips = hiddenL.map(p => h('button', { class: 'ghost sm vr-unhide', type: 'button', html: VIC.eye + '<span></span>', title: 'Scherm van ' + p.name + ' weer tonen', 'aria-label': 'Scherm van ' + p.name + ' weer tonen',
        onclick: () => { hid.delete(p.uid); const q = c.peers.get(p.uid); if (q) shareAudio(c, q); redrawAll(); } }));
      chips.forEach((b, i) => { b.lastChild.textContent = hiddenL[i].name; });
      const label = !shown.length ? (all.length === 1 ? 'Scherm verborgen' : 'Alle schermen verborgen') : multi ? shown.length + ' schermen live' : (shown[0].name + ' deelt zijn/haar scherm');
      const bar = multi || inFs || hiddenL.length ? h('div', { class: 'vr-bar' }, h('small', { class: 'hint', text: label }),
        h('div', { class: 'vr-seg' }, ...chips, ...(multi ? [seg('grid', 'Raster', VIC.grid), seg('focus', 'Focus', VIC.focus)] : []), ...(compact || !shown.length ? [] : [fsb]))) : null;
      let body = null;
      if (!shown.length) body = null;
      else if (focus) {
        const main = shown.find(p => p.uid === c.watching), rest = shown.filter(p => p !== main);
        body = h('div', { class: 'vr-streams focus' + (compact ? ' compact' : '') }, tile(main), h('div', { class: 'vr-strip' }, rest.map(tile)));
      } else {
        body = h('div', { class: 'vr-streams grid' + (multi ? '' : ' one') + (compact ? ' compact' : '') }, shown.map(tile));
        const cols = Math.ceil(Math.sqrt(shown.length)), rows = Math.ceil(shown.length / cols);   // in fullscreen past alles precies op het scherm
        body.style.setProperty('--cols', cols); body.style.setProperty('--rows', rows);
      }
      content.replaceChildren(...[bar, body].filter(Boolean));
    };
    root.addEventListener('fullscreenchange', draw);
    for (const b of [...blocks]) if (!b.root.isConnected) blocks.delete(b);
    blocks.add({ root, draw });
    if (!compact) state.fs = { root, update(l) { if (l.length) { list = l; draw(); } } };
    draw();
    return root;
  }
  // waar de zwevende kaart komt: tijdens fullscreen in het schermenblok zelf (anders is hij niet te zien), anders in de pagina of het pop-outvenster
  function fsHost() {
    const fe = document.fullscreenElement;
    return !pip.active() && fe && fe.classList.contains('vr-multi') ? fe : pip.host();
  }

  /* ---------- pop-out venster (v0.23) ---------- */
  const pip = createPip(); let growFailed = false;
  // (v0.27) bij een pop-outvenster de schermen ook op de pagina zelf tonen, als je dat wilt (wordt op dit toestel onthouden)
  let pageToo = false; try { pageToo = localStorage.getItem('inf.pipAlsoPage') === '1'; } catch {}
  function togglePageToo() { pageToo = !pageToo; try { localStorage.setItem('inf.pipAlsoPage', pageToo ? '1' : '0'); } catch {} if (state.room?.el.isConnected) state.room.paint(); }
  const watchedSharer = (c) => {   // welke deler tonen we? (de kanaalpagina en het pop-outvenster kiezen op dezelfde manier)
    const list = sharers(c);
    if (!list.some(p => p.uid === c.watching)) c.watching = list.length ? list[0].uid : null;
    return list;
  };
  async function openPip() {
    const c = state.cur; if (!c || pip.active() || !pip.supported()) return;
    try {
      await pip.open(sharers(c).length > 0, onPipClosed);
      if (state.cur !== c) { pip.close(); return; }
      growFailed = false; paintCard(); state.room?.paint();
    } catch (e) {
      if (e && e.name !== 'NotAllowedError' && e.name !== 'AbortError') X.toast('Pop-out openen is niet gelukt.');
    }
  }
  function onPipClosed() { growFailed = false; paintCard(); if (state.room?.el.isConnected) state.room.paint(); }   // de video gaat terug naar de kanaalpagina
  function closePip() { if (!pip.active()) return; pip.close(); growFailed = false; }
  const togglePip = () => { if (pip.active()) { closePip(); paintCard(); if (state.room?.el.isConnected) state.room.paint(); } else openPip(); };
  // het venster wordt groter zodra iemand een scherm deelt, en weer klein als dat stopt
  async function fitPip() {
    const c = state.cur; if (!c || !pip.active()) return;
    const want = sharers(c).length > 0;
    if (want === pip.isBig()) { if (growFailed) { growFailed = false; card?.classList.remove('needs-grow'); } return; }
    const ok = await pip.size(want);
    if (state.cur !== c || !pip.active()) return;
    growFailed = !ok; card?.classList.toggle('needs-grow', growFailed);
  }
  const btn = (cls, icon, label, on) => h('button', { class: 'call-b ' + cls, type: 'button', html: icon, title: label, 'aria-label': label, onclick: on });
  function paintCard() {
    const old = card, c = state.cur; if (!c) { closePip(); old?.remove(); card = null; return; }
    const n = people(c.sid, c.cid).length;
    const linked = [...c.peers.values()].filter(p => p.connected).length;
    const st = c.status === 'joining' ? 'Verbinden…' : c.srvMuted ? 'Gedempt door moderator' : (n > 1 && linked === 0 ? 'Verbinden met anderen…' : `Verbonden · ${n} ${n === 1 ? 'deelnemer' : 'deelnemers'}`);
    const mute = btn('mute' + (c.muted || c.srvMuted ? ' on' : ''), c.muted || c.srvMuted ? VIC.micOff : VIC.mic, c.muted ? 'Microfoon aanzetten' : 'Microfoon dempen', toggleMute);
    const deaf = btn('mute' + (c.deaf ? ' on' : ''), c.deaf ? VIC.headOff : VIC.head, c.deaf ? 'Geluid aanzetten' : 'Geluid uitzetten', toggleDeaf);
    const sh = canShare() && c.status === 'connected' ? btn('share' + (c.sharing ? ' on' : ''), VIC.screen, c.sharing ? 'Delen stoppen' : 'Scherm delen', () => (c.sharing ? stopShare() : startShare())) : null;
    const inPip = pip.active(), list = inPip ? watchedSharer(c) : [];
    const pb = pip.supported() ? btn('pip' + (inPip ? ' on' : ''), inPip ? VIC.pipBack : VIC.pip, inPip ? 'Terug naar de pagina' : 'Pop-out venster', togglePip) : null;
    let vwrap = null;
    if (list.length) vwrap = h('div', { class: 'call-vid multi' }, streamBlock(c, list, paintCard, true));   // in het pop-outvenster zitten alle gedeelde schermen in de kaart zelf
    const tabs = null;
    // alleen bij het allereerste verschijnen de pop-animatie; bij elke verandering daarna blijft de kaart rustig staan
    card = h('div', { class: 'call-card voice-card' + (old && old.dataset.k === key(c.sid, c.cid) ? ' nopop' : '') + (inPip ? ' in-pip' : '') + (list.length ? ' has-video' : '') + (inPip && growFailed ? ' needs-grow' : ''), 'data-k': key(c.sid, c.cid), role: 'dialog', 'aria-label': 'Spraakkanaal', 'data-st': c.status },
      h('span', { class: 'voice-ic', html: VIC.speaker, title: 'Sleep om te verplaatsen' }),
      h('button', { class: 'voice-tx', type: 'button', title: 'Naar het spraakkanaal', onclick: () => { try { window.focus(); } catch {} X.goTo(c.sid, c.cid); } },
        h('b', { text: c.name }), h('span', { class: 'call-st', text: st }), h('small', { text: c.sname })),
      h('div', { class: 'call-acts' }, mute, deaf, ...(sh ? [sh] : []), ...(pb ? [pb] : []), btn('no', VIC.leave, 'Verlaten', () => leave())),
      tabs, vwrap, h('button', { class: 'pip-grow', type: 'button', text: 'Klik om dit venster te vergroten', onclick: () => { growFailed = false; fitPip(); } }));
    if (!inPip) dragify(card);
    old?.remove(); fsHost().append(card);
    placeCard(card);
    fitPip();
  }

  /* ---------- lijst onder het kanaal in de zijbalk ---------- */
  function sideList(sid, cid) {
    const ppl = people(sid, cid); if (!ppl.length) return null;
    const c = state.cur, k = key(sid, cid);
    return h('div', { class: 'vside' }, ppl.map(p => h('div', { class: 'vside-row' + (c && c.speaking.has(p.uid) && key(c.sid, c.cid) === k ? ' speaking' : ''), 'data-vuid': p.uid, 'data-vcid': k },
      X.avatar(p.uid, p.name, 22, true, true),
      h('span', { class: 'vside-n', text: p.name }),
      p.srvMuted ? h('i', { class: 'vside-i', html: VIC.micOff, title: 'Gedempt door moderator' }) : p.muted && !p.deaf ? h('i', { class: 'vside-i', html: VIC.micOff, title: 'Gedempt' }) : null,
      p.deaf ? h('i', { class: 'vside-i', html: VIC.headOff, title: 'Geluid uit' }) : null,
      p.sharing ? h('i', { class: 'vside-i live', html: VIC.screen, title: 'Deelt scherm' }) : null)));
  }

  /* ---------- rechtermuisknopmenu op een deelnemer (v0.23) ---------- */
  // volume (alleen voor jou), en voor moderators: dempen en verwijderen. Op de telefoon: lang indrukken.
  let pmenu = null;
  const closePerson = () => { pmenu?.remove(); pmenu = null; };
  document.addEventListener('pointerdown', (e) => { if (pmenu && !pmenu.contains(e.target)) closePerson(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePerson(); });
  window.addEventListener('resize', closePerson);
  document.addEventListener('scroll', closePerson, true);
  const personActions = (s, ch, p, ctx) => ctx.canMod && p.uid !== S.me.uid && ctx.canActOn(p.uid);
  function personMenu(x, y, p, s, ch, ctx) {
    const c = state.cur, here = !!c && c.sid === s.id && c.cid === ch.id, mod = personActions(s, ch, p, ctx);
    if (p.uid === S.me.uid || !(here || mod)) return false;
    closePerson();
    const item = (icon, label, run, danger) => h('button', { class: 'ctx-i' + (danger ? ' danger' : ''), type: 'button', role: 'menuitem',
      onclick: (e) => { e.stopPropagation(); closePerson(); run(); } }, h('span', { class: 'ctx-ic', html: icon }), label);
    const rows = [h('div', { class: 'ctx-head' }, X.avatar(p.uid, p.name, 26, true, true), h('b', { text: p.name }))];
    if (here) rows.push(volumeSlider(h, p.uid, () => c.peers.get(p.uid)?.vol, { icon: VIC.speaker, label: 'Volume van ' + p.name, cls: 'ctx-vol' }));
    if (mod) {
      rows.push(item(p.srvMuted ? VIC.mic : VIC.micOff, p.srvMuted ? 'Dempen opheffen' : 'Dempen', () => modMute(s.id, ch.id, p.uid, !p.srvMuted).catch(e => X.toast(X.fbErr(e)))));
      rows.push(item(VIC.kick, 'Verwijderen uit kanaal', () => modKick(s.id, ch.id, p.uid).catch(e => X.toast(X.fbErr(e))), true));
    }
    pmenu = h('div', { class: 'ctx ctx-person', role: 'menu', 'aria-label': 'Opties voor ' + p.name }, rows);
    document.body.append(pmenu);
    const r = pmenu.getBoundingClientRect();
    pmenu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
    pmenu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
    (pmenu.querySelector('.ctx-i') || pmenu.querySelector('input'))?.focus({ preventScroll: true });
    return true;
  }
  // koppelt het menu aan een tegel: rechtermuisknop (of menutoets), of lang indrukken op een touchscherm
  function menuOn(el, p, s, ch, ctx) {
    el.addEventListener('contextmenu', (e) => { if (personMenu(e.clientX, e.clientY, p, s, ch, ctx)) { e.preventDefault(); e.stopPropagation(); } });
    let t = 0, st = null, fired = 0;
    const cancel = () => { clearTimeout(t); t = 0; };
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const q = e.touches[0]; st = { x: q.clientX, y: q.clientY }; cancel();
      t = setTimeout(() => { if (personMenu(st.x, st.y, p, s, ch, ctx)) { fired = Date.now(); navigator.vibrate?.(15); } }, 450);
    }, { passive: true });
    el.addEventListener('touchmove', (e) => { const q = e.touches[0]; if (st && (Math.abs(q.clientX - st.x) > 10 || Math.abs(q.clientY - st.y) > 10)) cancel(); }, { passive: true });
    el.addEventListener('touchend', (e) => { cancel(); if (Date.now() - fired < 800 && e.cancelable) e.preventDefault(); }, { passive: false });
    el.addEventListener('touchcancel', cancel, { passive: true });
  }

  /* ---------- het kanaalscherm (hoofdvenster) ---------- */
  // ctx: { canJoin, canMod, canActOn(uid), invite() }
  function room(s, ch, ctx) {
    const el = h('div', { class: 'vroom' });
    const k = key(s.id, ch.id);
    const limit = Math.max(2, Math.min(MAX_USERS, +ch.userLimit || MAX_USERS));
    let pending = false;
    // de video zit in het kanaalscherm; wordt dat opnieuw getekend, dan wordt de video even losgehaald en stopt fullscreen.
    // Daarom wachten we met tekenen tot je zelf uit fullscreen gaat.
    document.addEventListener('fullscreenchange', () => {
      if (!el.isConnected) return;
      if (!document.fullscreenElement && pending) { pending = false; paint(); }
    });
    const paint = () => {
      const fs = document.fullscreenElement;
      if (fs && el.contains(fs)) {
        pending = true;
        const cc = state.cur, list = cc ? sharers(cc) : [];
        if (!list.length) { try { document.exitFullscreen(); } catch {} }   // de deler is gestopt of weg: dan hoeft fullscreen ook niet meer
        else if (state.fs && state.fs.root === fs) state.fs.update(list);   // iemand erbij of weg: het fullscreenblok past zich zelf aan
        return;
      }
      pending = false;
      const c = state.cur, here = !!c && c.sid === s.id && c.cid === ch.id, ppl = people(s.id, ch.id);
      // (v0.27) zodra er schermen op de pagina staan, worden de deelnemers kleiner zodat alles in één scherm past (geen scrollen)
      const wide = here && sharers(c).length > 0 && (!pip.active() || pageToo);
      const tiles = ppl.map(p => {
        const me = p.uid === S.me.uid, spk = !!(c && key(c.sid, c.cid) === k && c.speaking.has(p.uid));
        const tile = h('div', { class: 'vt' + (!me ? ' vt-menu' : ''), tabindex: me ? null : 0 },
          h('div', { class: 'vt-av' + (spk ? ' speaking' : ''), 'data-vuid': p.uid, 'data-vcid': k }, X.avatar(p.uid, p.name, wide ? 44 : 76, true, true),
            p.srvMuted || (p.muted && !p.deaf) ? h('i', { class: 'vt-badge', html: VIC.micOff }) : p.deaf ? h('i', { class: 'vt-badge', html: VIC.headOff }) : null),
          h('b', { text: p.name + (me ? ' (jij)' : '') }),
          p.sharing ? h('span', { class: 'vt-live', html: VIC.screen + '<span>Live</span>' }) : null);
        if (!me) menuOn(tile, p, s, ch, ctx);
        return tile;
      });
      const acts = h('div', { class: 'vr-acts' });
      let stage = null;
      if (here) {
        const list = sharers(c);
        if (!list.some(p => p.uid === c.watching)) c.watching = list.length ? list[0].uid : null;
        if (list.length) {
          const who = list.find(p => p.uid === c.watching);
          if (pip.active()) {   // de schermen worden nu in het pop-outvenster getoond
            const tog = h('button', { class: 'ghost sm', type: 'button', html: (pageToo ? VIC.eyeOff : VIC.eye) + '<span>' + (pageToo ? 'Niet op de pagina tonen' : 'Ook op de pagina tonen') + '</span>', onclick: togglePageToo });
            const who2 = list.length === 1 ? who.name + ' deelt zijn/haar scherm' : list.length + ' mensen delen hun scherm';
            stage = pageToo
              ? h('div', { class: 'vr-stage multi' }, h('div', { class: 'vr-pipnote' }, h('small', { class: 'hint', text: who2 + '. Je ziet het ook in het pop-outvenster.' }), tog), streamBlock(c, list, paint, false, true))
              : h('div', { class: 'vr-stage me' }, h('div', { class: 'vr-pipnote' }, h('small', { class: 'hint', text: who2 + '. Je ziet het in het pop-outvenster.' }), tog));
          } else {
            stage = h('div', { class: 'vr-stage multi' }, streamBlock(c, list, paint, false),
              list.length === 1 ? h('small', { class: 'hint', text: who.name + ' deelt zijn/haar scherm' }) : null);
          }
        } else if (c.sharing) stage = h('div', { class: 'vr-stage me' }, h('small', { class: 'hint', text: 'Je deelt je scherm met iedereen in dit kanaal.' }));
        if (canShare() && c.status === 'connected') acts.append(h('button', { class: 'ghost' + (c.sharing ? ' on' : ''), type: 'button', html: VIC.screen + '<span>' + (c.sharing ? 'Delen stoppen' : 'Scherm delen') + '</span>', onclick: () => (c.sharing ? stopShare() : startShare()) }));
        acts.append(
          h('button', { class: 'ghost', type: 'button', html: (c.muted || c.srvMuted ? VIC.micOff : VIC.mic) + '<span>' + (c.muted ? 'Microfoon aan' : 'Dempen') + '</span>', onclick: toggleMute }),
          h('button', { class: 'ghost', type: 'button', html: (c.deaf ? VIC.headOff : VIC.head) + '<span>' + (c.deaf ? 'Geluid aan' : 'Geluid uit') + '</span>', onclick: toggleDeaf }),
          h('button', { class: 'glow danger', type: 'button', html: VIC.leave + '<span>Verlaten</span>', onclick: () => leave() }));
      } else {
        const full = ppl.length >= limit;
        acts.append(h('button', { class: 'glow', type: 'button', disabled: !ctx.canJoin || full, html: VIC.speaker + '<span>' + (c ? 'Verplaatsen naar dit kanaal' : 'Deelnemen') + '</span>',
          onclick: () => join(s.id, ch.id, { name: ch.name, sname: s.name, limit }) }));
        if (!ctx.canJoin) acts.append(h('small', { class: 'hint', text: 'Je mag in dit kanaal niet meedoen.' }));
        else if (full) acts.append(h('small', { class: 'hint', text: 'Dit kanaal zit vol.' }));
      }
      el.replaceChildren(
        h('div', { class: 'vr-top' }, h('span', { class: 'vr-ic', html: VIC.speaker }), h('div', {}, h('b', { text: ch.name }),
          h('small', { text: `${ppl.length} van ${limit} deelnemers` }))),
        stage,
        tiles.length ? h('div', { class: 'vr-grid' }, tiles) : h('p', { class: 'vr-empty', text: 'Nog niemand in dit kanaal. Doe mee en nodig een vriend uit!' }),
        ppl.length > 1 && (here || ctx.canMod) ? h('small', { class: 'hint vr-hint', text: 'Rechtsklik op iemand (op een telefoon: lang indrukken) om het volume aan te passen' + (ctx.canMod ? ' of te dempen en te verwijderen' : '') + '.' }) : null,
        acts);
      el.classList.toggle('has-streams', wide);
    };
    state.room = { el, paint };
    paint();
    return el;
  }

  window.addEventListener('pagehide', () => { const c = state.cur; if (c && S.me) deleteDoc(doc(presCol(c.sid, c.cid), S.me.uid)).catch(() => {}); });

  return {
    join, leave, room, sideList, people, modMute, modKick,
    watch(list) { state.want = list || []; applyWatch(); },
    active: () => !!state.cur,
    current: () => (state.cur ? { sid: state.cur.sid, cid: state.cur.cid } : null),
    setEnabled(on) { on = on !== false; if (on === state.enabled) return; state.enabled = on; if (!on && state.cur) leave('Spraakkanalen zijn door de beheerder uitgezet.'); },
    stop() { if (state.cur) leave(null, false); for (const w of state.watches.values()) w.unsub(); state.watches.clear(); state.roster.clear(); state.want = []; clearInterval(state.sweep); state.sweep = 0; state.room = null; }
  };
}
