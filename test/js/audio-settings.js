/* =====================  Instellingen: Spraak & geluid (v0.28)  =====================
   Het paneel bij Instellingen -> Spraak & geluid. Alle keuzes worden direct bewaard (per toestel) en gelden meteen in een lopend gesprek,
   op een paar na (zie `restartNote`). "Microfoon testen" opent je microfoon met precies deze instellingen en toont een meter, zodat je
   de gevoeligheid kunt afstellen voordat je belt. Het testgeluid blijft op je toestel. */
import { loadFx, saveFx, openMic, fxSupport, fxInUse, fxPending, listMics, FX_DEFAULT } from './audio-fx.js?v=0.29';

export function buildVoiceSettings(h) {
  const sup = fxSupport();
  let cfg = loadFx(), test = null, stopMeter = null, mics = [];
  const root = h('div', { class: 'fx' });

  /* ---- kleine bouwstenen ---- */
  const opts = (items, cur, on, disabled = {}) => h('div', { class: 'opts fx-opts' }, items.map(([k, title, sub]) => h('button', {
    class: 'opt fx-opt' + (cur === k ? ' active' : ''), type: 'button', disabled: !!disabled[k], 'aria-pressed': cur === k ? 'true' : 'false',
    onclick: () => on(k)
  }, h('span', { class: 'fx-opt-t' }, h('b', { text: title }), h('small', { text: sub })))));
  const slider = ({ label, min, max, step, value, fmt, on, dbl }) => {
    const out = h('output', { class: 'vol-val fx-val' });
    const inp = h('input', { class: 'vol-range', type: 'range', min, max, step, 'aria-label': label });
    const show = (v) => { out.textContent = fmt(v); inp.style.setProperty('--p', ((v - min) / (max - min) * 100) + '%'); };
    inp.value = value; show(+inp.value);
    inp.addEventListener('input', () => { show(+inp.value); on(+inp.value); });
    if (dbl != null) inp.addEventListener('dblclick', () => { inp.value = dbl; inp.dispatchEvent(new Event('input')); });
    return h('label', { class: 'vol-row fx-slider' }, h('span', { class: 'fx-slider-l', text: label }), inp, out);
  };
  const tog = (key, title, desc) => {
    const cb = h('input', { type: 'checkbox' }); cb.checked = !!cfg[key];
    cb.addEventListener('change', () => set({ [key]: cb.checked }, false));
    return h('label', { class: 'tog' }, h('span', { class: 'tog-text' }, h('b', { text: title }), h('small', { text: desc })), cb, h('i'));
  };
  const lbl = (t) => h('p', { class: 'set-lbl', text: t });

  const restartNote = h('p', { class: 'perm-note fx-note', hidden: true });
  async function set(patch, repaint = true) {
    cfg = { ...cfg, ...patch };
    const r = await saveFx(patch);
    restartNote.hidden = !(r === 'restart' || fxPending());
    restartNote.textContent = 'Je microfoon in het huidige gesprek gebruikt nog de oude instelling. Dit wordt actief als je het gesprek of spraakkanaal opnieuw start.';
    if (repaint) paint();
  }

  /* ---- meter + test ---- */
  const fill = h('div', { class: 'fx-fill' }), mark = h('div', { class: 'fx-mark', hidden: true });
  const meter = h('div', { class: 'fx-meter', role: 'img', 'aria-label': 'Microfoonniveau' }, fill, mark);
  const status = h('p', { class: 'hint fx-status', text: 'Druk op "Microfoon testen" en zeg iets. Maak ook eens het geluid dat je wilt wegfilteren.' });
  const testBtn = h('button', { class: 'ghost sm', type: 'button', onclick: () => (test ? stopTest() : startTest()) }, 'Microfoon testen');
  const loopCb = h('input', { type: 'checkbox' });
  loopCb.addEventListener('change', () => { if (test && !test.monitor(loopCb.checked)) loopCb.checked = false; });
  const loop = h('label', { class: 'tog fx-loop', hidden: true },
    h('span', { class: 'tog-text' }, h('b', { text: 'Hoor jezelf' }), h('small', { text: 'Luister naar hoe de anderen je horen. Gebruik een koptelefoon, anders krijg je een rondzingende toon.' })), loopCb, h('i'));

  function resetMeter() { fill.style.width = '0%'; fill.classList.remove('open'); mark.hidden = true; }
  async function startTest() {
    testBtn.disabled = true;
    try {
      test = await openMic(cfg, { force: true });
      if (!root.isConnected) { stopTest(); return; }
      testBtn.textContent = 'Test stoppen'; testBtn.classList.add('on');
      loop.hidden = false; loopCb.disabled = fxInUse(); loopCb.checked = false;
      if (test.note) status.textContent = test.note;
      mics = await listMics(); paint();   // namen zijn nu beschikbaar
      if (!test.pipeline) { status.textContent = 'De meter werkt niet op dit toestel (geen AudioWorklet). Je microfoon zelf werkt wel.'; return; }
      let last = 0;
      stopMeter = test.meter((m) => {
        if (!root.isConnected) { stopTest(); return; }
        const pct = Math.max(0, Math.min(100, (m.db + 80) / 80 * 100));
        fill.style.width = pct + '%'; fill.classList.toggle('open', !!m.open);
        if (m.thr != null) { mark.hidden = false; mark.style.left = Math.max(0, Math.min(100, (m.thr + 80) / 80 * 100)) + '%'; } else mark.hidden = true;
        const now = Date.now();
        if (now - last > 250) {
          last = now;
          const load = typeof m.load === 'number' ? ` · audioverwerking ${Math.round(m.load * 100)}% van de audiodraad` : '';
          status.textContent = (cfg.gate === 'off' ? (m.db > -60 ? 'Geluid wordt doorgegeven.' : 'Stil.') : (m.open ? 'Je stem wordt doorgegeven.' : 'Stil: er gaat niets naar de anderen.')) + load;
        }
      });
    } catch (e) {
      test = null; status.textContent = (e && e.message) || 'De microfoon kon niet worden gestart.';
    } finally { testBtn.disabled = false; }
  }
  function stopTest() {
    try { stopMeter?.(); } catch {} stopMeter = null;
    try { test?.stop(); } catch {} test = null;
    testBtn.textContent = 'Microfoon testen'; testBtn.classList.remove('on'); loop.hidden = true; loopCb.checked = false;
    resetMeter(); status.textContent = 'Druk op "Microfoon testen" en zeg iets. Maak ook eens het geluid dat je wilt wegfilteren.';
  }
  const guard = setInterval(() => { if (!root.isConnected) { clearInterval(guard); if (test) stopTest(); } }, 1500);   // paneel weg (andere pagina): microfoon loslaten

  /* ---- het paneel zelf ---- */
  function paint() {
    const off = { ai: !sup.ai };
    const gateOn = cfg.gate !== 'off';
    root.replaceChildren(...[
      lbl('Ruisonderdrukking'),
      opts([
        ['off', 'Uit', 'Je microfoon, zoals die is'],
        ['browser', 'Standaard', 'Ingebouwd in je browser. Bijna geen belasting'],
        ['ai', 'Sterk (AI)', 'Zoals Krisp: haalt toetsenbord, ventilator en achtergrondstemmen weg']
      ], cfg.mode, (k) => set({ mode: k }), off),
      cfg.mode === 'ai' && sup.ai ? h('p', { class: 'hint fx-hint', text: 'De AI-stand draait op je eigen toestel, vóór het versturen. Dat kost ruwweg 1 tot 3% van één processorkern. Zonder servers, dus de ander hoort meteen het schone geluid en je stem verlaat je toestel nooit onbewerkt.' }) : null,
      !sup.ai ? h('p', { class: 'hint fx-hint', text: sup.reason }) : null,

      lbl('Gevoeligheid'),
      opts([
        ['off', 'Altijd door', 'Geen filter op de stilte'],
        ['auto', 'Automatisch', 'Past zich aan je omgeving aan'],
        ['manual', 'Handmatig', 'Jij stelt de drempel in']
      ], cfg.gate, (k) => set({ gate: k }), { off: false, auto: !sup.worklet, manual: !sup.worklet }),
      cfg.gate === 'manual' ? slider({ label: 'Drempel', min: -80, max: -10, step: 1, value: cfg.open, fmt: (v) => v + ' dB', on: (v) => set({ open: v }, false), dbl: FX_DEFAULT.open }) : null,
      gateOn ? slider({ label: 'Nablijftijd', min: 50, max: 1000, step: 50, value: cfg.hold, fmt: (v) => v + ' ms', on: (v) => set({ hold: v }, false), dbl: FX_DEFAULT.hold }) : null,
      cfg.gate === 'auto' && cfg.mode !== 'ai' ? h('p', { class: 'hint fx-hint', text: 'Tip: automatisch werkt het best samen met "Sterk (AI)". Zonder AI kan de poort ruis van stemmen niet goed onderscheiden.' }) : null,
      gateOn ? h('p', { class: 'hint fx-hint', text: 'Alleen geluid boven de drempel gaat naar de anderen. Zie je de balk hieronder groen worden terwijl je praat, dan hoort men je.' }) : null,

      h('div', { class: 'fx-test' }, meter, status, h('div', { class: 'fx-test-row' }, testBtn), loop),

      lbl('Microfoon'),
      micSelect(),
      slider({ label: 'Microfoonvolume', min: 0, max: 200, step: 5, value: cfg.vol, fmt: (v) => v + '%', on: (v) => set({ vol: v }, false), dbl: 100 }),

      lbl('Extra'),
      tog('hp', 'Lage tonen wegfilteren', 'Haalt gebrom, ventilator en bonken op tafel weg (alles onder ca. 90 Hz).'),
      tog('echo', 'Echo-onderdrukking', 'Voorkomt dat de anderen zichzelf horen als je geen koptelefoon draagt.'),
      tog('agc', 'Automatische volumeregeling', 'Houdt je volume gelijk. Zet uit als je het volume zelf wilt bepalen.'),
      restartNote,
      h('p', { class: 'hint fx-hint', text: 'Deze instellingen gelden alleen op dit toestel, want elke microfoon is anders. Dubbelklik op een schuif om terug te gaan naar de standaardwaarde.' }),
      h('button', { class: 'ghost sm', type: 'button', onclick: () => set({ ...FX_DEFAULT }) }, 'Alles terugzetten')].filter(Boolean));   // replaceChildren zet null om in de tekst "null"
  }
  function micSelect() {
    const sel = h('select', { class: 'inp fx-mic', 'aria-label': 'Microfoon' }, h('option', { value: '', text: 'Standaardmicrofoon' }),
      mics.filter(m => m.id && m.id !== 'default').map(m => h('option', { value: m.id, text: m.label })));
    sel.value = cfg.device && mics.some(m => m.id === cfg.device) ? cfg.device : '';
    sel.addEventListener('change', () => set({ device: sel.value }, false));
    return sel;
  }
  listMics().then(m => { mics = m; if (root.isConnected && !test) paint(); });
  paint();
  return root;
}
