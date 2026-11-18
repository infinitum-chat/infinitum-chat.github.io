/* =====================  Microfoon & ruisonderdrukking (v0.28)  =====================
   Eén plek die de microfoon opent voor bellen (call.js) en spraakkanalen (voice.js), met instellingen zoals Discord/Krisp:

   - Ruisonderdrukking:  'off'     = niets (jouw ruwe microfoon)
                         'browser' = de ingebouwde ruisonderdrukking van je browser/besturingssysteem (native code, bijna geen belasting)
                         'ai'      = RNNoise (AI-model, als Krisp): haalt toetsenbord, ventilator, muisklikken en achtergrondstemmen weg
   - Gevoeligheid (noise gate): 'off' | 'auto' (zoekt zelf het achtergrondniveau) | 'manual' (jij stelt de drempel in)
   - Volume van je microfoon, lage tonen wegfilteren, echo-onderdrukking, automatische volumeregeling en welke microfoon.

   Alles gebeurt op je eigen toestel, vóórdat het geluid wordt verstuurd: de anderen horen direct het schone geluid, en niets gaat naar een server.
   De AI-stand draait als WebAssembly op de audiodraad van de browser (zie js/fx/). Dat is licht, maar niet gratis: reken op
   ruwweg 1-3% van één processorkern. De instellingen staan per toestel (localStorage), want elke microfoon is anders.
   Zonder AI, gevoeligheid, volume of filter wordt de microfoon gewoon rechtstreeks gebruikt, precies zoals vóór v0.28. */

const KEY = 'infinitum-voicefx';
export const FX_DEFAULT = Object.freeze({
  mode: 'browser',   // 'off' | 'browser' | 'ai'
  gate: 'off',       // 'off' | 'auto' | 'manual'
  open: -50,         // drempel (dB) bij gate 'manual'
  hold: 250,         // ms na het laatste geluid voordat de poort sluit
  vol: 100,          // microfoonvolume in % (0-200)
  hp: false,         // lage tonen filteren (bonk, ventilator)
  echo: true,        // echo-onderdrukking van de browser
  agc: true,         // automatische volumeregeling van de browser
  device: ''         // gekozen microfoon ('' = standaard)
});
const V = (() => { try { return new URL(import.meta.url).search || ''; } catch { return ''; } })();
const asset = (p) => new URL('./fx/' + p, import.meta.url).href.split('?')[0] + V;

const num = (v, lo, hi, d) => { v = +v; return isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d; };
export function sanitizeFx(r) {
  r = r && typeof r === 'object' ? r : {};
  const D = FX_DEFAULT;
  return {
    mode: ['off', 'browser', 'ai'].includes(r.mode) ? r.mode : D.mode,
    gate: ['off', 'auto', 'manual'].includes(r.gate) ? r.gate : D.gate,
    open: num(r.open, -80, -10, D.open), hold: num(r.hold, 50, 1500, D.hold), vol: num(r.vol, 0, 200, D.vol),
    hp: typeof r.hp === 'boolean' ? r.hp : D.hp, echo: typeof r.echo === 'boolean' ? r.echo : D.echo, agc: typeof r.agc === 'boolean' ? r.agc : D.agc,
    device: typeof r.device === 'string' ? r.device.slice(0, 300) : ''
  };
}
let cache = null;
export function loadFx() {
  if (cache) return { ...cache };
  try { cache = sanitizeFx(JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { cache = sanitizeFx({}); }
  return { ...cache };
}

/* ---------- wat kan dit toestel? ---------- */
export function fxSupport() {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const worklet = !!(AC && window.AudioWorkletNode && AC.prototype && 'audioWorklet' in AC.prototype && window.WebAssembly && !ios);
  let reason = '';
  if (ios) reason = 'Op iPhone en iPad staat de AI-stand uit: de geluidsverwerking kan stoppen zodra de app op de achtergrond komt. De ingebouwde ruisonderdrukking blijft werken.';
  else if (!worklet) reason = 'Deze browser kan de AI-stand niet draaien (AudioWorklet of WebAssembly ontbreekt). De ingebouwde ruisonderdrukking blijft werken.';
  return { worklet, ai: worklet, ios, reason };
}
const needsPipeline = (c) => c.mode === 'ai' || c.gate !== 'off' || c.vol !== 100 || c.hp;

/* ---------- microfoon openen ---------- */
async function getMic(c) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Deze browser kan niet bellen (geen microfoon-ondersteuning).');
  const audio = { echoCancellation: c.echo, noiseSuppression: c.mode === 'browser', autoGainControl: c.agc, channelCount: { ideal: 1 } };
  if (c.device) audio.deviceId = { ideal: c.device };   // 'ideal': is die microfoon weg, dan pakt de browser gewoon een andere
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video: false });
  } catch (e) {
    const n = e && e.name;
    if (n === 'OverconstrainedError' || n === 'ConstraintNotSatisfiedError') {
      try { return await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); } catch (e2) { e = e2; }
    }
    const nm = e && e.name;
    throw new Error(nm === 'NotAllowedError' || nm === 'SecurityError' ? 'Geen toegang tot je microfoon. Sta de microfoon toe in je browser- of telefooninstellingen.'
      : nm === 'NotFoundError' ? 'Er is geen microfoon gevonden.' : 'De microfoon kon niet worden gestart.');
  }
}
const track = (s) => s.getAudioTracks()[0];
const applyNative = (raw, c) => track(raw)?.applyConstraints({ echoCancellation: c.echo, noiseSuppression: c.mode === 'browser', autoGainControl: c.agc }).catch(() => {});

let rnWasm = null;
async function loadWasm() {
  if (rnWasm) return rnWasm;
  const simd = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  const r = await fetch(asset(simd ? 'rnnoise_simd.wasm' : 'rnnoise.wasm'));
  if (!r.ok) throw new Error('RNNoise niet gevonden');
  return (rnWasm = await r.arrayBuffer());
}

const live = new Set();   // alle open microfoons (gesprek, spraakkanaal, test), zodat een gewijzigde instelling meteen overal doorkomt

/* openMic(cfg?, { force }) -> sessie:
   { stream, raw, pipeline, note, cfg, update(cfg), meter(cb), monitor(bool), stop() }
   stream = wat je aan de verbinding hangt; raw = de echte microfoon. Stop altijd met sessie.stop() (stopt beide en sluit de audio-context).
   force: bouw altijd de filterketen (voor de test met meter). */
export async function openMic(cfg0, opts = {}) {
  let cfg = sanitizeFx(cfg0 || loadFx());
  const sup = fxSupport();
  let note = '';
  const eff = (c) => (c.mode === 'ai' && !sup.ai ? { ...c, mode: 'browser' } : c);
  if (cfg.mode === 'ai' && !sup.ai) note = sup.reason;
  const raw = await getMic(eff(cfg));
  const S = { raw, stream: raw, pipeline: false, note, cfg, test: !!opts.force, pending: false, ac: null };
  const want = sup.worklet && (opts.force || needsPipeline(eff(cfg)));
  let g = null;   // knooppunten
  if (want) {
    try { g = await build(S, eff(cfg)); }
    catch (e) {
      console.warn('Filterketen starten mislukt, gewone microfoon gebruikt:', e);
      destroyGraph(S, S.g); S.g = null; S.stream = raw; S.pipeline = false;
      S.note = 'De geluidsfilters konden niet starten; je microfoon werkt gewoon, met de ingebouwde ruisonderdrukking.';
      applyNative(raw, { ...cfg, mode: cfg.mode === 'off' ? 'off' : 'browser' }); g = null;
    }
  }
  S.g = g;

  S.update = async (next) => {
    next = sanitizeFx(next);
    const prev = S.cfg; S.cfg = next;
    const e = eff(next);
    if (!S.pipeline) {
      applyNative(S.raw, e);
      if (sup.worklet && needsPipeline(e) && !S.pipelineFailed) { S.pending = true; return 'restart'; }
      if (next.device !== prev.device) { S.pending = true; return 'restart'; }
      S.pending = false; return 'ok';
    }
    const gr = S.g;
    gr.gate.port.postMessage({ mode: next.gate, open: next.open, hold: next.hold, gain: next.vol / 100 });
    gr.hp.frequency.value = next.hp ? 90 : 10;
    applyNative(S.raw, e);
    try {
      if (e.mode === 'ai') await ensureAi(S, gr);
      route(gr, e.mode === 'ai' && !!gr.rn);
      if (next.device !== prev.device) {
        const nr = await getMic(e), old = S.raw; S.raw = nr;
        gr.src.disconnect(); gr.src = gr.ac.createMediaStreamSource(nr); route(gr, e.mode === 'ai' && !!gr.rn);
        old.getTracks().forEach(t => t.stop());
      }
    } catch (err) { console.warn('Instelling toepassen mislukt:', err); S.pending = true; return 'restart'; }
    S.pending = false; return 'ok';
  };
  S.meter = (cb) => {   // cb({ db, open, thr, load })
    if (!S.pipeline) return () => {};
    S.g.gate.port.postMessage({ report: true });
    S.g.onMeter = (m) => cb({ ...m, load: S.load });
    try {
      const rc = S.g.ac.renderCapacity;
      if (rc) { rc.addEventListener('update', S.g.onLoad = (ev) => { S.load = ev.averageLoad; }); rc.start({ updateInterval: 1 }); }
    } catch {}
    return () => { try { S.g?.gate.port.postMessage({ report: false }); S.g.onMeter = null; S.g.ac.renderCapacity?.stop?.(); } catch {} };
  };
  S.monitor = (on) => { if (!S.pipeline) return false; try { on ? S.g.gate.connect(S.g.ac.destination) : S.g.gate.disconnect(S.g.ac.destination); } catch {} return true; };
  S.stop = () => {
    if (S.stopped) return; S.stopped = true; live.delete(S);
    destroyGraph(S, S.g);
    try { S.raw.getTracks().forEach(t => t.stop()); } catch {}
    try { S.stream.getTracks().forEach(t => t.stop()); } catch {}
  };
  S.pipelineFailed = want && !S.pipeline;
  live.add(S);
  return S;
}

async function build(S, c) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC({ sampleRate: 48000, latencyHint: 'interactive' });
  const gr = { ac };
  S.g = gr;
  await ac.resume().catch(() => {});
  await ac.audioWorklet.addModule(asset('gate-worklet.js'));
  gr.src = ac.createMediaStreamSource(S.raw);
  gr.hp = ac.createBiquadFilter(); gr.hp.type = 'highpass'; gr.hp.Q.value = 0.7; gr.hp.frequency.value = c.hp ? 90 : 10;
  gr.gate = new AudioWorkletNode(ac, 'infinitum-gate', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
    processorOptions: { mode: c.gate, open: c.open, hold: c.hold, gain: c.vol / 100 }
  });
  gr.gate.port.onmessage = (e) => { if (e.data && 'db' in e.data) gr.onMeter?.(e.data); };
  gr.dest = ac.createMediaStreamDestination();
  gr.gate.connect(gr.dest);
  if (c.mode === 'ai') await ensureAi(S, gr);
  route(gr, c.mode === 'ai' && !!gr.rn);
  const wake = () => { if (ac.state !== 'running' && ac.state !== 'closed') ac.resume().catch(() => {}); };
  ac.onstatechange = wake;
  gr.vis = () => { if (document.visibilityState === 'visible') wake(); };
  document.addEventListener('visibilitychange', gr.vis);
  S.stream = gr.dest.stream; S.pipeline = true; S.ac = ac;
  return gr;
}
async function ensureAi(S, gr) {
  if (gr.rn) return;
  const [bin] = await Promise.all([loadWasm(), gr.ac.audioWorklet.addModule(asset('rnnoise-worklet.js'))]);
  gr.rn = new AudioWorkletNode(gr.ac, '@sapphi-red/web-noise-suppressor/rnnoise', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
    processorOptions: { maxChannels: 1, wasmBinary: bin }
  });
}
// microfoon -> (hoogdoorlaat) -> (RNNoise) -> filter/gevoeligheid -> uitgang
function route(gr, ai) {
  try { gr.src.disconnect(); gr.hp.disconnect(); gr.rn?.disconnect(); } catch {}
  gr.src.connect(gr.hp);
  if (ai && gr.rn) { gr.hp.connect(gr.rn); gr.rn.connect(gr.gate); } else gr.hp.connect(gr.gate);
}
function destroyGraph(S, gr) {
  if (!gr) return;
  try { document.removeEventListener('visibilitychange', gr.vis); } catch {}
  try { gr.rn?.port.postMessage('destroy'); } catch {}
  for (const n of [gr.src, gr.hp, gr.rn, gr.gate, gr.dest]) { try { n?.disconnect(); } catch {} }
  try { gr.ac.onstatechange = null; gr.ac.close(); } catch {}
  S.pipeline = false;
}

/* ---------- opslaan (en meteen doorgeven aan alle open microfoons) ---------- */
const subs = new Set();
export const onFx = (cb) => { subs.add(cb); return () => subs.delete(cb); };
export async function saveFx(patch) {
  const next = sanitizeFx({ ...loadFx(), ...patch });
  cache = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
  const res = await Promise.all([...live].map(s => s.update(next).catch(() => 'restart')));
  for (const cb of subs) { try { cb(next); } catch {} }
  return res.includes('restart') ? 'restart' : 'ok';
}
export const fxPending = () => [...live].some(s => s.pending && !s.test);
export const fxInUse = () => [...live].some(s => !s.test);

/* lijst met microfoons (namen zijn pas zichtbaar nadat de microfoon een keer is toegestaan) */
export async function listMics() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(d => d.kind === 'audioinput' && d.deviceId !== 'communications').map((d, i) => ({ id: d.deviceId, label: d.label || ('Microfoon ' + (i + 1)) }));
  } catch { return []; }
}
