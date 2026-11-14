/* Infinitum stemfilter (AudioWorklet): volume + "gevoeligheid" (noise gate) zoals bij Discord.
   - mode 'off'    : geen filter, alleen volume
   - mode 'manual' : het geluid gaat door als het harder is dan `open` (dB); sluit pas weer na `hold` ms stilte
   - mode 'auto'   : zoekt zelf het achtergrondniveau en opent iets daarboven (past zich aan als de omgeving verandert)
   Een korte vertraging (look-ahead) zorgt dat het begin van een woord niet wordt afgeknipt, en de overgangen zijn zacht (geen getik).
   Draait op de audiodraad van de browser en doet per blokje van 128 samples maar een paar rekensommen. */
const LOOK_MS = 8;

class InfinitumGate extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.c = Object.assign({ mode: 'off', open: -50, hold: 250, gain: 1, report: false }, (opts && opts.processorOptions) || {});
    const n = Math.max(1, Math.round(sampleRate * LOOK_MS / 1000));
    this.look = n; this.bufs = []; this.pos = 0;
    this.env = 1e-9;                 // gemeten vermogen (vloeiend)
    this.floor = -55; this.warm = sampleRate;                // geschat achtergrondniveau in dB (auto)
    this.isOpen = false; this.holdLeft = 0;
    this.g = 0;                      // huidige poortversterking 0..1
    this.aUp = 1 - Math.exp(-1 / (sampleRate * 0.004));
    this.aDn = 1 - Math.exp(-1 / (sampleRate * 0.060));
    this.rep = 0;
    this.port.onmessage = (e) => { if (e.data && typeof e.data === 'object') Object.assign(this.c, e.data); };
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length || !out || !out.length) return true;
    const c = this.c, N = inp[0].length, L = this.look;
    // meten op het ingangssignaal (kanaal 0)
    let s = 0; const x0 = inp[0]; for (let i = 0; i < N; i++) s += x0[i] * x0[i];
    const p = s / N + 1e-12;
    this.env += (p - this.env) * (p > this.env ? 0.25 : 0.06);   // iets traag omhoog: een enkele klik opent de poort niet
    const db = 10 * Math.log10(this.env);
    const blockMs = N / sampleRate * 1000;
    let thr = c.open;
    if (c.mode === 'auto') {
      if (this.warm > 0) this.warm -= N;   // de eerste seconde meten we niet: de microfoon/AI start met stilte en dat zou het niveau te laag schatten
      else if (db < this.floor) this.floor = Math.max(-85, db); else this.floor = Math.min(-45, this.floor + 1.0 * N / sampleRate);   // zakt snel mee, stijgt langzaam
      thr = Math.max(-72, Math.min(-33, this.floor + 16));
    }
    let want = true;
    if (c.mode !== 'off') {
      if (db > thr) { this.isOpen = true; this.holdLeft = c.hold; }
      else if (this.isOpen) { this.holdLeft -= blockMs; if (db < thr - 5 && this.holdLeft <= 0) this.isOpen = false; }
      want = this.isOpen;
    } else this.isOpen = true;
    const tgt = want ? 1 : 0, vol = c.gain;
    for (let ch = 0; ch < out.length; ch++) {
      const x = inp[Math.min(ch, inp.length - 1)], y = out[ch];
      let b = this.bufs[ch]; if (!b) b = this.bufs[ch] = new Float32Array(L);
      let g = this.g, pos = this.pos;
      for (let i = 0; i < N; i++) {
        g += (tgt - g) * (tgt > g ? this.aUp : this.aDn);
        const d = b[pos]; b[pos] = x[i]; if (++pos >= L) pos = 0;
        y[i] = d * g * vol;
      }
      if (ch === out.length - 1) { this.g = g; this.pos = pos; }
    }
    if (c.report && (this.rep += N) >= sampleRate / 20) {   // 20x per seconde de meter bijwerken
      this.rep = 0;
      this.port.postMessage({ db, open: this.isOpen, thr: c.mode === 'off' ? null : thr });
    }
    return true;
  }
}
registerProcessor('infinitum-gate', InfinitumGate);
