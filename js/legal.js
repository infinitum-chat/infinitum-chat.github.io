/* Infinitum: cookies, algemene voorwaarden, privacybeleid en huisregels.
   De teksten staan in Firestore (legal/terms, legal/privacy, legal/rules) en zijn aan te passen in Admin -> Voorwaarden.
   Bestaat er (nog) niets in Firestore, dan worden de standaardteksten hieronder getoond. */
import { db, enableAnalytics } from './firebase.js?v=0.21';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';

export const LEGAL_DOCS = [
  { id: 'terms', title: 'Algemene voorwaarden' },
  { id: 'privacy', title: 'Privacybeleid' },
  { id: 'rules', title: 'Huisregels' }
];

export const LEGAL_DEFAULT = {
terms: `Algemene Voorwaarden Infinitum
Laatst bijgewerkt: 6-11-2026

Artikel 1: Definities
In deze algemene voorwaarden worden de volgende termen in de navolgende betekenis gebruikt, tenzij uit de uitdrukkelijke context anders blijkt:
Infinitum: De website, het platform, de applicaties en de bijbehorende diensten aangeboden onder de naam Infinitum.
Gebruiker: Iedere natuurlijke persoon of rechtspersoon die de website bezoekt, zich registreert of gebruikmaakt van de diensten van Infinitum.
Diensten: Alle functionaliteiten, content en diensten die via het platform van Infinitum ter beschikking worden gesteld.

Artikel 2: Toepasselijkheid
Deze algemene voorwaarden zijn van toepassing op elk bezoek aan en elk gebruik van de website, applicaties en diensten van Infinitum.
Door gebruik te maken van Infinitum ga je akkoord met deze algemene voorwaarden. Indien je niet akkoord bent met deze voorwaarden, dien je direct het gebruik van het platform te staken.
Infinitum behoudt zich het recht voor om deze voorwaarden te allen tijde te wijzigen. De meest actuele versie is altijd te raadplegen via het platform. De publicatiedatum staat altijd bovenaan de pagina.

Artikel 3: Account en Registratie
Voor het gebruiken van bepaalde functionaliteiten van Infinitum is het aanmaken van een account vereist. Je bent zelf verantwoordelijk voor het geheimhouden van je inloggegevens en voor alles wat er met je account gebeurt.
Om een account aan te maken dien je minimaal 16 jaar oud te zijn, dan wel te beschikken over de uitdrukkelijke toestemming van een ouder of wettelijke voogd.
Je kunt je e-mailadres en wachtwoord op elk moment wijzigen via Instellingen. Onder Instellingen zie je ook op welke apparaten je bent ingelogd en kun je apparaten uitloggen.
Je kunt je account op elk moment zelf verwijderen via Instellingen. Het verwijderen is definitief en kan niet ongedaan worden gemaakt.
Infinitum heeft het recht om accounts te weigeren, te schorsen of te verwijderen indien er sprake is van misbruik, overtreding van de regels of het verstrekken van onjuiste gegevens.

Artikel 4: Gebruik van de Dienst
Het is ten strengste verboden om Infinitum te gebruiken voor illegale doeleinden, het verspreiden van schadelijke software (zoals malware of virussen), of activiteiten die de goede werking van het platform kunnen verstoren.
Het is niet toegestaan om beveiligingsmaatregelen van Infinitum te omzeilen, te doorbreken of ongeautoriseerde toegang te verkrijgen tot systemen en accounts.
Gebruikers dienen zich te houden aan de geldende wet- en regelgeving, aan de Huisregels van Infinitum en mogen de rechten van derden niet schenden.

Artikel 5: Inhoud van gebruikers
Je blijft eigenaar van de berichten en bestanden die je op Infinitum plaatst. Je geeft Infinitum wel toestemming om deze weer te geven aan de mensen voor wie je ze bedoelt, en om ze op te slaan zolang dat nodig is om de dienst te leveren.
Je bent zelf verantwoordelijk voor wat je plaatst. Infinitum mag inhoud die in strijd is met deze voorwaarden of de Huisregels verwijderen.

Artikel 6: Intellectueel Eigendom
Alle intellectuele eigendomsrechten met betrekking tot Infinitum, waaronder mede begrepen de software, vormgeving, teksten, logo's, grafische elementen en broncode, berusten uitsluitend bij Infinitum en haar licentiegevers.
Het is zonder voorafgaande schriftelijke toestemming niet toegestaan om materiaal van Infinitum te kopiëren, te distribueren, openbaar te maken of te gebruiken voor commerciële doeleinden.

Artikel 7: Aansprakelijkheid
Infinitum wordt geleverd op een "as is" basis. Wij bieden geen garanties met betrekking tot de continue beschikbaarheid, foutloosheid of betrouwbaarheid van de diensten.
Infinitum is niet aansprakelijk voor indirecte schade, gederfde winst, bedrijfsstagnatie of dataverlies voortvloeiend uit het gebruik van het platform, voor zover de wet dit toestaat.`,

privacy: `Privacybeleid Infinitum
Laatst bijgewerkt: 6-11-2026

Bij Infinitum respecteren wij de privacy van alle gebruikers van onze website. Wij zorgen ervoor dat de persoonlijke informatie die je met ons deelt vertrouwelijk wordt behandeld.

1. Welke gegevens verzamelen wij?
Accountgegevens: Gegevens die je invult bij het aanmaken van een account, zoals je gebruikersnaam en e-mailadres (of je Google-account als je daarmee inlogt).
Profielgegevens: Wat je zelf toevoegt, zoals profielfoto, banner, bio, status en links.
Inhoud: Je berichten, reacties, vriendschappen, servers en je instellingen.
Apparaatgegevens: Een lijst van apparaten waarop je bent ingelogd (naam van browser en besturingssysteem, tijdstip van laatste gebruik), en een pushtoken als je pushmeldingen aanzet.
Gebruiksgegevens: Technische gegevens over je bezoek aan onze website en applicaties, zoals IP-adressen, browsertype en interacties met het platform.

2. Doel van de gegevensverwerking
Wij gebruiken verzamelde gegevens uitsluitend voor de volgende doeleinden:
Het aanbieden, onderhouden en beveiligen van het platform.
Het beheren van accounts en het bieden van gebruikersondersteuning.
Het versturen van meldingen die je zelf hebt aangezet.
Het analyseren en verbeteren van onze diensten (alleen als je analytische cookies hebt geaccepteerd).

3. Cookies en lokale opslag
Infinitum gebruikt functionele opslag in je browser om je ingelogd te houden en je thema en keuzes te onthouden. Daarvoor is geen toestemming nodig.
Analytische cookies (Google Analytics via Firebase) plaatsen we alleen als je die accepteert in het cookievenster. Je keuze wordt op je apparaat bewaard.

4. Met wie delen wij gegevens?
Infinitum draait op diensten van Google (Firebase: inloggen, database, hosting, meldingen en analytics) en Cloudflare (afbeeldingen en pushserver). Deze partijen verwerken gegevens in onze opdracht. Wij verkopen je gegevens niet.

5. Beveiliging en Bewaartermijn
Infinitum hanteert passende technische en organisatorische beveiligingsmaatregelen om persoonsgegevens te beschermen tegen verlies, misbruik of onbevoegde toegang.
Wij bewaren persoonsgegevens niet langer dan strikt noodzakelijk is voor de doeleinden waarvoor ze zijn verzameld, tenzij een wettelijke bewaartermijn anders voorschrijft.
Verwijder je je account, dan worden je accountgegevens, profiel, instellingen, apparaten, vriendschappen en berichten verwijderd. Servers die jij hebt gemaakt, worden ook verwijderd.

6. Jouw Rechten
Je hebt het recht om je persoonsgegevens in te zien, te laten corrigeren of te laten verwijderen. Je e-mailadres, wachtwoord en gebruikersnaam kun je zelf wijzigen en je account kun je zelf verwijderen via Instellingen. Voor een kopie van je gegevens of andere vragen kun je contact opnemen via de beheerders binnen het platform.
Ben je het niet eens met hoe wij met je gegevens omgaan, dan kun je een klacht indienen bij de Autoriteit Persoonsgegevens.`,

rules: `Huisregels van Infinitum

Om ervoor te zorgen dat Infinitum voor iedereen een veilige, prettige en respectvolle omgeving blijft, gelden de volgende gedragsregels:

Wederzijds respect: Ga met respect om met andere gebruikers. Beledigingen, pesterijen, intimidatie, bedreigingen en discriminatie zijn ten strengste verboden.
Geen spam of ongepaste inhoud: Het plaatsen van spam, ongevraagde reclame, phishing-links of misleidende informatie is niet toegestaan.
Veiligheid en privacy: Deel geen gevoelige persoonsgegevens (zoals wachtwoorden, adresgegevens of telefoonnummers) van jezelf of anderen op openbare plekken binnen het platform.
Geen illegale content: Het uploaden, delen of verspreiden van illegale, schadelijke of ongepaste inhoud is verboden.
Handhaving: Overtreding van deze huisregels kan resulteren in een officiële waarschuwing, een tijdelijke schorsing of het permanent blokkeren van je account.`
};

/* ---------- laden (zonder inloggen: legal/* is publiek leesbaar) ---------- */
const cache = {};
export async function loadLegal(id, force) {
  if (!force && cache[id]) return cache[id];
  let out = { text: LEGAL_DEFAULT[id], custom: false };
  try {
    const s = await getDoc(doc(db, 'legal', id));
    if (s.exists() && typeof s.data().text === 'string' && s.data().text.trim()) out = { text: s.data().text, custom: true };
  } catch (e) { console.warn('Voorwaarden laden:', e); }
  cache[id] = out;
  return out;
}

/* ---------- platte tekst -> nette opmaak (altijd via textContent) ----------
   Eerste regel = titel, "Laatst bijgewerkt: ..." = kleine regel, "Artikel N: ..." of "1. ..." = kop,
   "Woord: uitleg" = vet woord + uitleg, andere regels = gewone alinea's. */
export function renderLegalText(text) {
  const box = document.createElement('div');
  box.className = 'legal-text';
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let first = true;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let el;
    if (first) { el = document.createElement('h3'); el.textContent = line; first = false; }
    else if (/^laatst bijgewerkt/i.test(line)) { el = document.createElement('p'); el.className = 'legal-date'; el.textContent = line; }
    else if (/^(artikel\s+\d+\b.*|\d+\.\s+.*)$/i.test(line) && line.length < 90) { el = document.createElement('h4'); el.textContent = line; }
    else {
      el = document.createElement('p');
      const m = line.match(/^([^:.]{2,40}):\s+(.*)$/);
      if (m) { const b = document.createElement('b'); b.textContent = m[1] + ': '; el.append(b, m[2]); }
      else el.textContent = line;
    }
    box.append(el);
  }
  return box;
}

/* ---------- venster met tabbladen ---------- */
let dlgEl = null;
export function openLegal(which = 'terms') {
  if (!dlgEl) {
    dlgEl = document.createElement('dialog');
    dlgEl.id = 'legalDlg';
    dlgEl.className = 'legal-dlg';
    dlgEl.addEventListener('click', e => { if (e.target === dlgEl) dlgEl.close(); });
    document.body.append(dlgEl);
  }
  const body = document.createElement('div'); body.className = 'legal-body';
  const tabs = document.createElement('div'); tabs.className = 'seg legal-tabs';
  const show = async (id) => {
    tabs.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.id === id));
    body.replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Laden…' }));
    const d = await loadLegal(id);
    body.replaceChildren(renderLegalText(d.text));
    body.scrollTop = 0;
  };
  for (const d of LEGAL_DOCS) {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.id = d.id; b.textContent = d.title;
    b.addEventListener('click', () => show(d.id));
    tabs.append(b);
  }
  const close = document.createElement('button'); close.type = 'button'; close.className = 'ghost'; close.textContent = 'Sluiten';
  close.addEventListener('click', () => dlgEl.close());
  const actions = document.createElement('div'); actions.className = 'dlg-actions'; actions.append(close);
  const inner = document.createElement('div'); inner.className = 'dlg-in'; inner.append(tabs, body, actions);
  dlgEl.replaceChildren(inner);
  if (!dlgEl.open) dlgEl.showModal();
  show(which);
}

// links met data-legal="terms|privacy|rules" openen het venster (ook die in dynamisch gemaakte schermen)
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('[data-legal]');
  if (!a) return;
  e.preventDefault();
  openLegal(a.dataset.legal);
});

/* ---------- cookievenster ----------
   Keuze staat in localStorage 'infinitum-cookies' = 'all' | 'necessary'. Zonder keuze blokkeert het venster de pagina. */
const COOKIE_KEY = 'infinitum-cookies';
export const cookieChoice = () => { try { return localStorage.getItem(COOKIE_KEY); } catch { return null; } };
export function setCookieChoice(v) {
  try { localStorage.setItem(COOKIE_KEY, v); } catch {}
  if (v === 'all') enableAnalytics(); 
}
export function initCookies() {
  const c = cookieChoice();
  if (c === 'all') enableAnalytics();
  if (c) return;
  const wrap = document.createElement('div');
  wrap.className = 'cookie-wrap';
  wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-label', 'Cookies');
  const card = document.createElement('div'); card.className = 'cookie-card panel';
  const h3 = document.createElement('h3'); h3.textContent = 'Cookies';
  const p = document.createElement('p');
  p.append('Infinitum gebruikt cookies en lokale opslag om je ingelogd te houden en je keuzes te onthouden. Met analytische cookies zien we hoe de app gebruikt wordt, zodat we hem kunnen verbeteren. Lees meer in ons ');
  const a = document.createElement('a'); a.href = '#'; a.dataset.legal = 'privacy'; a.textContent = 'Privacybeleid';
  p.append(a, '.');
  const acts = document.createElement('div'); acts.className = 'cookie-acts';
  const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'glow'; ok.textContent = 'Accepteren';
  const nec = document.createElement('button'); nec.type = 'button'; nec.className = 'ghost'; nec.textContent = 'Alleen noodzakelijke';
  const done = (v) => { setCookieChoice(v); wrap.remove(); };
  ok.addEventListener('click', () => done('all'));
  nec.addEventListener('click', () => done('necessary'));
  acts.append(nec, ok);
  card.append(h3, p, acts);
  wrap.append(card);
  document.body.append(wrap);
  ok.focus();
}
