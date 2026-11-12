# Infinitum als webapp (PWA)

## 1. Online zetten (nodig voor installeren + pushmeldingen)
Een webapp en pushmeldingen werken alleen via **https**. Het makkelijkst is Firebase Hosting (zit al in je project):

```
npm i -g firebase-tools
firebase login
firebase deploy --only hosting,firestore:rules
```
Daarna staat de app op `https://chat-a5794.web.app`. Voeg dat domein (en `chat-a5794.firebaseapp.com`) toe onder
Firebase Console → Authentication → Instellingen → Geautoriseerde domeinen als het er nog niet staat.

## 2. Installeren op je telefoon
- **Android (Chrome):** open de link → Instellingen in Infinitum → *App & pushmeldingen* → **Installeren** (of ⋮ → App installeren).
- **iPhone/iPad (Safari):** Deel → **Zet op beginscherm**. (Alleen zo werken pushmeldingen op iOS, vanaf iOS 16.4.)

## 3. Pushmeldingen aanzetten (eenmalig, door jou als beheerder)
1. Firebase Console → Projectinstellingen → **Cloud Messaging** → *Web Push-certificaten* → **Sleutelpaar genereren**.
2. Plak de publieke sleutel in `js/firebase.js` bij `VAPID_KEY`.
3. Zet het project op het **Blaze-abonnement** (nodig voor Cloud Functions; je betaalt pas boven een ruime gratis hoeveelheid).
4. Controleer in `functions/index.js` dat `region` bij je Firestore-locatie past (Console → Firestore → Instellingen).
5. Deploy:
```
cd functions && npm install && cd ..
firebase deploy
```
6. Open de app op je telefoon → Instellingen → *App & pushmeldingen* → zet **Pushmeldingen op dit toestel** aan.

Meldingen komen binnen bij nieuwe DM's, serverberichten, vriendschapsverzoeken, inbox-meldingen en (voor moderators) nieuwe
upgrade-aanvragen. Ze respecteren je meldingsinstellingen en "Niet storen".

## Let op
- Een telefoon die **helemaal uit** staat kan niets ontvangen. Staat hij aan met vergrendeld scherm of is de app dicht, dan komt de melding wel binnen; ook als hij weer aangaat, bezorgt Google de melding (tot 24 uur).
- Na een nieuwe versie van de bestanden: verhoog `VERSION` in `sw.js` zodat telefoons de nieuwe bestanden ophalen.

## Servers, kanalen, rollen en mentions (v0.6)
- **Deploy alles opnieuw** (regels + functions + hosting): `firebase deploy`. De nieuwe `firestore.rules` zijn nodig; zonder werken kanalen, rollen en mentions niet.
- **Officiële server**: de eerste gebruiker met de moderatorbadge die inlogt, maakt hem automatisch aan (id `official`, met kanaal #nieuws waar alleen beheerders posten). Daarna worden alle gebruikers bij het inloggen automatisch lid. Alleen moderatoren beheren hem; verlaten en verwijderen kan niet.
- **Kanalen**: `#algemeen` (id `general`) staat nog op de oude plek, dus bestaande servers en berichten blijven werken. Rechten per kanaal: bekijken, berichten sturen, berichten beheren (rol of `@gebruiker`).
- **Rollen**: `@everyone` (impliciet), standaard `Beheerder` en `Moderator`, eigen rollen met kleur en rechten. Gebruik `@rolnaam` en `@gebruikersnaam` in berichten; rolnamen hebben geen spaties.
- **Meldingen bij mentions** (inbox + push): zonder Blaze-abonnement komen die van de **Cloudflare Worker** (`worker.js`), net als de andere pushmeldingen; met Blaze kan `functions/index.js` hetzelfde doen (zelfde meldings-id's, dus nooit dubbel). Nieuwe instelling: Instellingen → Meldingen → Vermeldingen.
  Let op: de Worker moet de **nieuwe** `worker.js` draaien (Cloudflare → je Worker → Edit code → plakken → Deploy) en `PUSH_URL` in `js/firebase.js` moet ingevuld zijn; zonder Worker komen er geen vermeldingsmeldingen.

## Wijzigingen in v0.7 (servers)
- Rollen in de kanaalrechten werden als `[object HTMLLabelElement]` getoond (geneste lijsten in de DOM-bouwer `h()`); opgelost, rollen zijn nu gewoon te kiezen per kanaal.
- Nieuwe rollen krijgen een eigen volgnummer (onderaan), zodat omhoog/omlaag schuiven werkt; een verwijderde rol verdwijnt ook uit de kanaalrechten; de editors springen niet meer naar boven.
- Vermeldingen: `@everyone.` / `@rol,` / `@naam!` met leesteken werken nu; `@rolnaam` zonder het recht is gewone tekst maar `@gebruiker` werkt; e-mailadressen tellen niet; opgezochte gebruikersnamen worden onthouden (minder lezingen).
- Worker: kent nu kanalen, rollen en vermeldingen (inbox-melding + push), en stuurt niets naar mensen die het kanaal niet mogen zien.
- Firestore: LRU-geheugencache (wisselen tussen kanalen/chats leest niet steeds alles opnieuw), in een grote server (>40 leden) worden max. 40 leden live gevolgd (3 luisteraars per lid), en de officiële server wordt niet elke minuut opnieuw geprobeerd aan te maken.
- De beveiligingsregels (`firestore.rules`) zijn ongewijzigd.
- Het recht “Rollen beheren” is in de praktijk een vertrouwd recht (die persoon kan zichzelf rollen geven); geef het alleen aan beheerders. “Beheerder” zelf kan alleen door een beheerder worden gewijzigd.

## Wijzigingen in v0.8
**Opnieuw uploaden/deployen:** `firestore.rules` (nieuwe regels), `worker.js` (plakken in Cloudflare → Deploy), en bij Blaze ook `functions/`. Daarna de site (hosting). Zonder de nieuwe regels kan de instelling "pc-modus" niet worden opgeslagen.

- **Admin → Mensen**: elke gebruiker toont zijn **user-ID** (met kopieerknop en een link "in Firebase" naar het `users`-document), je kunt op user-ID zoeken, en bovenaan staat een knop naar de Firebase Console (`chat-a5794`).
- **Geen meldingen op je telefoon als je op de pc zit**: staat standaard aan en is aan te passen bij Instellingen → Meldingen ("Geen meldingen op telefoon als je op de pc zit"). Zit je actief op de pc (online, hartslag van de laatste 4,5 min), dan sturen de Worker/Functions geen push naar je telefoon en toont een geopende telefoon-app zelf ook niets. Staat je pc op de achtergrond/inactief of gesloten, dan komen meldingen op je telefoon gewoon binnen.
- **Ongelezen in servers (zoals Discord)**:
  - Kanaal met nieuwe berichten = **wit randje** links van het kanaal (en bij de server in de serverbalk); de kanaalnaam wordt vetter.
  - **Vermeldingen** (@jij, @jouwrol, @everyone) = een **rode teller** op het tabblad *Servers*, op de server en op het kanaal waar het vandaan komt. Open je het kanaal, dan verdwijnt hij.
  - Vermeldingen staan **niet meer in het meldingencentrum** (de bel). Oude vermeldingsmeldingen worden stilletjes opgeruimd; de Worker/Functions maken ze niet meer aan. Pushmeldingen voor vermeldingen blijven bestaan.
  - Gelezen-status wordt per apparaat bewaard (net als bij DM's). Er worden maximaal 60 kanalen tegelijk gevolgd.
- **Infinitum+: bannerafbeelding**: een afbeelding als profielbanner kan alleen met Infinitum+ of Prime. Gratis kies je een **kleur**. Dit staat ook in de beveiligingsregels (zonder Plus/Prime kun je geen afbeelding opslaan) en een bestaande afbeelding van iemand zonder abonnement wordt niet getoond. De standaardtabel met functies is bijgewerkt; heb je de tabel al in Firestore staan, pas hem dan aan via Admin → Tabel (rij "Banner met eigen kleur" gratis, "Banner met eigen afbeelding" vanaf Plus).
- Klein: de tekst "null" in de serverkop (voor leden zonder beheerrechten) is weg.

## Wijzigingen in v0.9
**Opnieuw uploaden/deployen:** `firestore.rules` (verplicht, anders werken uitnodigingen/foto's/Plus-servers niet), `worker.js` (plakken in Cloudflare → Deploy) en daarna de site (hosting).

- **Server maken = Infinitum+.** Alleen leden met Plus of Prime kunnen een server maken (knop toont een Infinitum+-label, anders komt de upgrade-melding). Ook in de beveiligingsregels afgedwongen. Bestaande servers blijven gewoon werken, en iedereen kan nog steeds in een server zitten.
- **Serveruitnodigingen i.p.v. een code.** In de serverkop (en bij Serverinstellingen) staat nu **Uitnodigen**: kies vrienden en zij krijgen in hun DM een kaartje met servericoon, naam en een **Join**-knop (of "Open server" als ze er al in zitten). Je kunt het kaartje ook in het kanaal zelf plaatsen. De code en "Joinen met code" zijn uit de app verdwenen. De regels checken dat de afzender echt in die server zit en dat naam/icoon kloppen, dus er zijn geen nepkaartjes te maken. Voor het uitnodigen heb je een vriend nodig (DM).
- **Nieuwskanalen** (kanaaltype "Nieuwskanaal", het oude "Aankondigingen"): elk bericht staat **groot en in het midden**. In het kanaal bewerken (Serverinstellingen → Kanalen → potlood) kan de moderator **"Toon wie het bericht stuurde"** aan of uit zetten. Uit = lezers zien geen naam of foto. (Dit is alleen de weergave; moderators zien in Firestore nog steeds wie het stuurde.) Het kanaal `nieuws` in de officiële server is gewoon zo'n kanaal.
- **Tekst opmaken zoals Discord** (DM's en servers): `**dik**`, `*schuin*` of `_schuin_`, `__onderstreept__`, `~~doorgestreept~~`, `` `code` ``, ```` ``` ````codeblok, `||spoiler||`, `# Groot`, `## Middel`, `### Kleiner`, `-# klein`, `> citaat`, `- lijstje`. Met `\` voor een teken zet je het opmaakteken uit. Boven het invoerveld staan knoppen (B, I, U, S, Groot, code, citaat); Ctrl/Cmd+B, I en U werken ook. Alles wordt als tekst opgebouwd, nooit als HTML.
- **Links worden meteen klikbaar** (`https://…` en `www.…`), openen in een nieuw tabblad.
- **Scherpe foto's.** Via de knop links van het invoerveld, plakken (Ctrl+V) of slepen. Het **originele bestand** gaat naar **Cloudflare R2** via je bestaande Worker (niet naar Firestore, dat alleen het adres bewaart). Max. 10 MB; jpg/png/webp/gif blijven ongewijzigd, andere of te grote foto's gaan als JPEG van hoge kwaliteit (max. 4096 px). Klik op een foto voor de volledige weergave.

### (Vervangen in v0.11 door Cloudinary, zie onderaan) Eenmalig instellen voor foto's (Cloudflare R2)
1. Cloudflare → **R2 Object Storage** → **Create bucket** (bijv. `infinitum-media`). R2 vraagt een betaalmethode, maar de gratis hoeveelheid (10 GB, geen downloadkosten) is ruim.
2. Cloudflare → **Workers** → jouw Worker → **Settings → Bindings → Add → R2 bucket**: *Variable name* `MEDIA`, kies de bucket → Deploy.
3. De nieuwe `worker.js` plakken en deployen (zie boven). `PUSH_URL` in `js/firebase.js` moet ingevuld zijn (is al zo).
Foto's worden uitgeleverd via `https://<jouw-worker>/m/…`. Zonder stap 1-2 geeft de app bij een foto de melding dat het nog niet is ingesteld; alles anders werkt gewoon. Let op: een verwijderd bericht laat de foto in R2 staan (je kunt oude foto's in de R2-bucket zelf opruimen). Als je Worker-adres ooit verandert, werken oude foto's niet meer (het adres staat in het bericht).

## Cookies, voorwaarden, account en apparaten (v0.10)
- **Deploy alles opnieuw**: `firebase deploy` (regels, functions én hosting). Zonder nieuwe `firestore.rules` werken voorwaarden bewerken, apparaten en account verwijderen niet; zonder de nieuwe functie `cleanupDeletedUser` blijven berichten van verwijderde accounts staan.
- **Cookievenster**: bij het eerste bezoek moet iemand kiezen (Accepteren / Alleen noodzakelijke). Analytics start alleen na "Accepteren". Keuze staat in `localStorage` (`infinitum-cookies`).
- **Voorwaarden, privacybeleid, huisregels**: links onder het inlogscherm en in Instellingen. Teksten bewerk je in Admin → Voorwaarden (opgeslagen in `legal/terms|privacy|rules`); zonder opgeslagen tekst worden de standaardteksten uit `js/legal.js` getoond.
- **Instellingen → Account**: e-mail wijzigen (Firebase stuurt een bevestigingsmail naar het nieuwe adres), wachtwoord wijzigen, account verwijderen.
- **Account vergeten**: knop op het inlogscherm; Firebase verstuurt zelf de herstelmail (geen eigen mailserver nodig). Pas eventueel de mailtekst aan in Firebase Console → Authentication → Templates.
- **Apparaten**: `sessions/{uid}/devices/{id}`. Uitloggen op afstand werkt zodra dat apparaat online is of de app opent.


## Wijzigingen in v0.11: foto's via Cloudinary (geen betaalmethode nodig)
**Opnieuw uploaden/deployen:** `firestore.rules` (verplicht) en de site (hosting). De Worker hoeft **niet** opnieuw.

Foto's gaan nu rechtstreeks van de browser naar Cloudinary. In Firestore staat alleen het adres. R2 is niet meer nodig.
Oude foto's (via de Worker/R2) blijven werken zolang `PUSH_URL` klopt.

### Foto's instellen (Cloudinary), eenmalig
1. Maak een gratis account op https://cloudinary.com (kies *Programmable Media*; geen creditcard nodig).
2. **Cloud name**: Dashboard → *Go to API Keys* (of Settings → API Keys) → kopieer de **Cloud name**.
3. **Upload preset**: Settings (tandwiel) → *Upload* → tabblad *Upload presets* → **Add upload preset**:
   - *Preset name*: bijv. `infinitum`
   - *Signing mode*: **Unsigned**  (belangrijk)
   - *Asset folder* (of *Folder*): `chat`
   - *Unique filename*: aan, *Overwrite*: uit, *Use filename*: uit
   - *Allowed formats*: `jpg,png,webp,gif`
   - **Save**
4. Zet in `js/firebase.js`: `CLOUDINARY_CLOUD = 'jouw-cloud-name'` en `CLOUDINARY_PRESET = 'infinitum'`.
5. Deploy: `firebase deploy --only hosting,firestore:rules`.
6. Test: open de app (ververs een keer hard), stuur een foto. Hij verschijnt dan ook in Cloudinary → *Media Library* → map `chat`.


## Wijzigingen in v0.12
**Opnieuw uploaden/deployen:** `firestore.rules` (verplicht: stemmen, moderatie en anonieme meldingen), `worker.js` (plakken in Cloudflare → Deploy), bij Blaze ook `functions/`, en daarna de site (hosting). Zonder de nieuwe regels geeft stemmen op aanvragen en de moderatiefunctie een "permission-denied".

- **Opmaakbalk alleen bij selectie.** De balk met B, I, U, S, Groot, code en citaat staat er niet meer altijd. Hij verschijnt zodra je tekst in het invoerveld selecteert en zweeft dan boven het veld, dus hij kost op de telefoon geen ruimte meer.
- **Geen dubbele meldingen.** Naast "geen melding op de telefoon als je op de pc zit" (bestond al) krijg je ook geen push meer op je telefoon als je *zelf in de app op die telefoon zit*. Op iPhone toonde de service worker een push altijd, ook met de app open; nu stuurt de Worker/Functions hem dan helemaal niet (hartslag van de telefoon < 100 s oud). De telefoon stuurt daarvoor nu elke minuut een hartslag (pc: elke 2 min). Staat de app dicht of op de achtergrond, dan komen meldingen gewoon binnen.
- **Chat scrolt naar beneden met foto's.** Foto's reserveren hun plek al voor ze geladen zijn (afmetingen uit het bericht) en als een foto toch later laadt terwijl je onderaan staat, scrolt de chat mee. Scrol je omhoog, dan blijft hij staan waar je was.
- **Abonnementen: stemmen i.p.v. "1 afwijzing is definitief".** Elke moderator (niet de aanvrager) stemt één keer: goedkeuren of afwijzen (afwijzen met reden). **Twee keer goedkeuren = goedgekeurd, twee keer afwijzen = afgewezen. Staat het 1-1, dan beslist de derde moderator.** De stemmen staan in `subscriptions/<uid>.votes` met tellers `yes` en `no`; in Admin → Aanvragen zie je de stand en wie wat stemde (de aanvrager ziet alleen hoeveel moderators gekeken hebben, niet wie of wat). Een aanvraag uit v0.11 met een eerste goedkeuring (`step1`) telt gewoon als 1 stem voor.
- **Admin → Moderatie (anoniem waarschuwen).** Nieuw tabblad Moderatie, en bij Mensen een knop **Moderatie**. Je kiest een actie, vinkt standaardredenen aan (spam, beledigen/pesten, haat, ongepaste inhoud, oplichting/verdacht gedrag, doen alsof je iemand anders bent, persoonlijke gegevens delen, andere huisregels) en kunt een toelichting toevoegen. De trap is verplicht en wordt ook door de beveiligingsregels afgedwongen:
  1. **Waarschuwing** (anoniem, in het meldingencentrum van de gebruiker; tab "Moderatie").
  2. **Tijdelijke time-out** (1 u, 6 u, 24 u, 3 d of 7 d) kan pas na minstens 1 waarschuwing. De gebruiker kan dan geen berichten of vriendschapsverzoeken sturen; het invoerveld toont tot wanneer.
  3. **Ban** kan pas na minstens 1 time-out. De app toont dan een blokkadescherm met de reden en een uitlogknop.
  - **Opheffen** kan altijd. Moderators kunnen zichzelf of een andere moderator niet modereren.
  - De gebruiker ziet nooit welke moderator het deed (afzender is "Moderatie"); in Admin → Moderatie staat een logboek (alleen voor moderators) met wie wat deed en waarom. Collecties: `moderation/<uid>` (stand) en `modLog/<id>` (logboek).
  - Wil je ook een directe ban toestaan zonder trap? Haal dan in `firestore.rules` (blok `moderation`) de voorwaarde `pt >= 1` bij `ban` weg en zet in `openModDialog` (`js/app.js`) `ok` van Ban op `!st?.banned`.

## Wijzigingen in v0.13: Streakr

- **Friends + Requests zijn nu één pagina "Friends"** (verzoeken verschijnen bovenaan zodra er iets openstaat; de teller staat op het Friends-tabblad).
- **Nieuw tabblad Streakr**: overzicht van al je vrienden met streak, "Begin een streak!", of "Streak afgelopen!" + **Herstellen**.
  Je streak groeit als jullie allebei op dezelfde dag (Nederlandse tijd) een streakr sturen. Mis je een dag, dan is hij afgelopen.
- **Streakr sturen**: camera (voor/achter, of foto kiezen), filters, bijschrift, kijktijd 3/5/10 s, meerdere vrienden tegelijk.
  Foto's zijn bewust klein (max. 640 px, lage JPEG-kwaliteit) en kunnen **1x** bekeken worden; met **Infinitum+ (en Prime) 3x**. Daarna wordt de foto gewist.
  Met Cloudinary ingesteld gaat de foto daarheen; anders staat hij (klein) tijdelijk in Firestore en wordt hij na het bekijken leeggemaakt.
- **Herstellen = Infinitum Prime**: 3 herstellers, +1 bij een streak van 100, 300, 500, 700… dagen (telt de beste streak die je ooit had).
  Zonder Prime opent de knop de upgrade-vraag. Nog niet vernieuwd per maand: het zijn er 3 in totaal (aanpassen: `BASE_RESTORES` in js/streakr.js).
- **Top 10** van de hoogste lopende streaks, met wie. Sta je erin, dan krijg je op je profiel een **Streakr #plek**-badge.
- Streak-teller (🔥 + ⏳ als hij bijna afloopt) en een blokje bij een nieuwe streakr staan ook naast je vrienden in de DM-lijst; in een DM zit een camera-knop.
- Pushmelding "heeft een streakr gestuurd" (Worker: nieuw type `streakr`, **deploy de Worker opnieuw**).

Opnieuw publiceren: `firebase deploy --only hosting,firestore:rules` (nieuwe regels voor `snaps`, `streaks`, `streakUsers`).
Let op: er is geen server die streaks controleert; de regels beperken vals spelen (max. +1 per 10 min, herstellen alleen Prime) maar de dagtelling gebeurt in de app.

## v0.13 – aanpassingen na test (zelfde versienummer)
**Opnieuw uploaden:** `firestore.rules` (Plus 2x / Prime 3x kijken + `openedAt`), daarna hosting.
- Telefoondetectie (o.a. Samsung A36 in de app) kijkt nu ook naar het toesteltype, niet alleen naar de aanwijzer.
- Profielfoto's in de Streakr-kijker en de vriendenkeuze laden nu.
- Streakr-blokje in de DM-chat (verzonden/geopend); 24 uur na openen verdwijnt het.
- Reageren op een streakr: typbalk onder de foto, of met het cameraatje een streakr terugsturen.
- Top 10 staat nu bovenaan (horizontaal scrollen).
- Camera start op de achterzijde; filters weg; bijschrift kleiner en versleepbaar.
- Streakr bekijken: gratis 1x, Infinitum+ 2x, Prime 3x.

## Wijzigingen in v0.14
**Opnieuw uploaden:** `firestore.rules` (verplicht: `pins` en de nieuwe `liveness`), **`worker.js` (plakken in Cloudflare → Deploy; nodig voor de nieuwe meldingenlogica)**, bij Blaze ook `functions/`, en daarna hosting (`firebase deploy --only hosting,firestore:rules`).

- **Foto's.** Klik op een foto: met Infinitum+ (en Prime) opent een viewer met **inzoomen** (muiswiel, knoppen, `+` `-` `0`, dubbelklik, knijpen op de telefoon, tot 800%) en slepen. **Downloaden** (het originele bestand) kan alleen met **Infinitum Prime**. **Doorsturen** van foto's kan iedereen (knop in de viewer, of rechtermuisknop/lang indrukken). Zonder Plus blijft de gewone grote weergave. Rijen "Foto’s inzoomen" (Plus) en "Foto’s downloaden" (Prime) staan in de standaardtabel; staat de tabel al in Firestore, voeg ze dan toe via Admin → Tabel.
- **Chats vastpinnen (max. 3 directe berichten).** Rechtermuisknop (pc) of lang indrukken (telefoon) op een chat → Vastpinnen/Losmaken, of het speldje dat bij de chat verschijnt. Vastgepinde chats staan bovenaan. Opgeslagen in `settings/{uid}.pins`, dus op al je apparaten hetzelfde.
- **Servers: wie las het?** Muis over het oogje + cijfertje (of tik erop op de telefoon) klapt een vakje uit met iedereen die het las: naam + kleine profielfoto, laatste lezer bovenaan.
- **Emoji-reacties: wie reageerde?** Muis over een reactie (op de telefoon: lang indrukken) toont wie met die emoji reageerde. Tikken/klikken wisselt nog steeds je eigen reactie.
- **Streakr-camera: inzoomen.** Knijpen met twee vingers, dubbeltik, of de schuif onderaan. Heeft de camera echte zoom (veel Android-telefoons), dan wordt die gebruikt; anders digitaal (alleen het midden wordt bewaard).
- **Meldingen op je telefoon (opnieuw gedaan).** Elk toestel schrijft nu een eigen hartslag in `liveness/<uid>`, los van je status:
  - Zit je **achter je pc** (Infinitum open en de laatste 5 min iets gedaan), dan krijg je **niets op je telefoon**, ook niet als je op onzichtbaar, offline of een andere status staat.
  - Zit je **in de app op je telefoon**, dan krijg je ook geen push (de app toont het zelf), ook niet bij onzichtbaar/offline.
  - Ga je **van je pc af** (5 min niets doen) en er staan nog ongelezen berichten open, dan krijg je **één melding op je telefoon**: "Je hebt nog X ongelezen berichten open staan." Daarna komen nieuwe berichten gewoon binnen.
  - Sluit je het tabblad of gaat de pc uit/in slaapstand: na 4,5 min verloopt de hartslag en komt alles weer op je telefoon. De "nog X open"-melding kan dan niet verstuurd worden (de pc is dan al weg); die komt alleen bij weggaan met de pc nog aan.
  - Niet storen blijft alles tegenhouden. De "nog X open"-melding gaat alleen via de Cloudflare Worker (niet via Functions) en alleen naar telefoons/tablets.
  - Aanpassen: `IDLE_AFTER` in `js/app.js` (5 min).

## Wijzigingen in v0.15: emoji (typbalk)
- Naast de fotoknop zit een emoji-knop (svg-icoon). Die opent een popup met zoekbalk, categorietabs (recent, smileys & mensen, dieren, eten, reizen, activiteiten, voorwerpen, symbolen, vlaggen) en een voorbeeldregel met de `:code:`.
- Typ je `:sob:` dan wordt dat meteen 😭 (zelfde namen als Discord/Slack/GitHub: `:joy:`, `:+1:`, `:rocket:`, `:flag_nl:` …). Typ je `:pizz` dan verschijnt een aanvul-lijstje (pijltjes + Enter/Tab, of tikken). Tekst tussen `backticks` blijft ongemoeid.
- Bestanden: `js/emoji.js` (knop, popup, aanvullen) en `js/emoji-data.js` (lijst met namen/zoekwoorden, ~130 kB, wordt pas geladen bij eerste gebruik). Geen server-aanpassingen of nieuwe Firestore-regels nodig.

## Wijzigingen in v0.16: Streakr-foto's (Cloudinary of Firestore) en reageren op een streakr
**Opnieuw uploaden:** `firestore.rules` (verplicht: nieuw document `config/streakr` en `replyTo.snap`), daarna hosting (`firebase deploy --only hosting,firestore:rules`). `worker.js` en `functions/` zijn ongewijzigd.

- **Admin → Streakr**: kies voor **iedereen** hoe streakr-foto's worden opgeslagen.
  - **Cloudinary (goede kwaliteit)**: foto's tot 1280 px, JPEG 85%, het bestand staat bij Cloudinary en in Firestore alleen het adres. Kijkers krijgen hem op max. 1280 px.
  - **Firestore (lage kwaliteit)**: zoals voorheen, tot 640 px en sterk verkleind, rechtstreeks in het `snaps`-document. Cloudinary is dan niet nodig.
  - De keuze staat in `config/streakr` (`storage`: `cloudinary` of `firestore`) en geldt voor alle streakrs die daarna worden verstuurd. Is er niets gekozen, dan wordt Cloudinary gebruikt als `CLOUDINARY_CLOUD` en `CLOUDINARY_PRESET` in `js/firebase.js` zijn ingevuld, anders Firestore. Al verstuurde streakrs blijven zoals ze zijn (beide soorten worden gewoon getoond).
  - Cloudinary instellen: zie "Foto's instellen (Cloudinary)" bij v0.11.
- **Reageren op een streakr**: typ je onder een streakr een reactie, dan staat die in de chat met bovenaan **"Gereageerd op streakr"** (zoals bij andere berichten). Klik erop en de chat scrolt naar het streakr-blokje (dat blijft 24 uur na openen staan). Is het blokje al weg, dan krijg je een melding dat de streakr niet meer bestaat.

## Wijzigingen in v0.17: spamdetectie met time-out van 2 minuten
**Opnieuw uploaden:** `firestore.rules` (verplicht: nieuwe collecties `spamLocks` en `spamLog`), daarna hosting (`firebase deploy --only hosting,firestore:rules`). `worker.js` en `functions/` zijn ongewijzigd. Zonder de nieuwe regels geldt de time-out alleen in de app zelf en komt er niets in het logboek.

- **Automatische spamdetectie.** Drie signalen (alleen voor gewone gebruikers; moderators zijn uitgezonderd). De drempels staan in `SPAM_RULES` in `js/app.js`:
  - **Te veel berichten achter elkaar**: 6 berichten binnen 8 seconden.
  - **Hetzelfde bericht herhaald**: 4 keer precies hetzelfde bericht binnen 30 seconden (ook over verschillende gesprekken heen; foto's, uitnodigingen en doorsturen tellen hier niet mee).
  - **Veel berichten met links**: 5 berichten met een link binnen 60 seconden.
- **Time-out van 2 minuten.** Het bericht dat de grens overschrijdt wordt niet verstuurd (de tekst blijft in het invoerveld staan). Het invoerveld is 2 minuten vergrendeld en toont tot wanneer en waarom. Dit wordt ook door de beveiligingsregels afgedwongen (`spamLocked()` in `firestore.rules`), dus nieuwe berichten worden in die tijd echt geweigerd. Na afloop komt er een melding dat je weer kunt typen.
- **Uitleg aan de gebruiker.** Direct bij de time-out opent een venster: wat er gezien werd (bijv. "Je stuurde 6 berichten in 4 seconden"), tot hoe laat de time-out duurt, en dat moderators dit kunnen terugzien.
- **Admin → Moderatie → spam-logboek.** Onder het gewone logboek staat per geval: **wie** (naam + user-ID), **wat** (welk signaal en de reden), **wanneer**, en **welke berichten precies** (klap "N berichten bekijken" open: tekst, tijd, in welk gesprek of kanaal, en of het bericht verstuurd of geblokkeerd werd). Loopt de time-out nog, dan kan een moderator hem met **Time-out opheffen** ophalen (bijvoorbeeld bij een vals alarm). Collecties: `spamLocks/<uid>` en `spamLog/<id>`.
- **Let op:** de detectie draait in de app van de gebruiker. De time-out zelf wordt wel door Firestore afgedwongen, maar iemand met een aangepaste app kan de detectie omzeilen. Voor volledig serverside detectie is een Cloud Function nodig (Blaze).

## Wijzigingen in v0.18: berichten melden, vrienden blokkeren/melden en moderatie van meldingen
**Opnieuw uploaden:** `firestore.rules` (verplicht: nieuwe collecties `blocks` en `reports` + `reports/<id>/notes`, nieuw meldingstype `report_result` en een blokkeer-controle bij vriendschapsverzoeken), daarna hosting. `worker.js` en `functions/` zijn ongewijzigd. Er zijn geen extra Firestore-indexen nodig.

- **Bericht melden.** Rechtermuisknop (pc) of lang indrukken (telefoon) op andermans bericht → **Bericht melden** (in DM's en servers). Kies 1 tot 3 redenen, schrijf eventueel een toelichting, en vink zo nodig "ook blokkeren" aan. Het bericht en de 3 berichten ervoor worden meegestuurd als bewijs, ook bij privégesprekken (die moderators anders niet kunnen lezen). Per melder kan een bericht maar 1x gemeld worden.
- **Gebruiker melden.** Via het profiel (Melden), het ⋯-menu rechtsboven in een DM, of het vlaggetje in je vriendenlijst.
- **Vrienden blokkeren, verwijderen, melden.**
  - Friends: per vriend de knoppen *Melden*, *Blokkeren* en *Verwijderen* (met bevestiging). Bij binnenkomende verzoeken staat ook een blokkeerknop.
  - **Blokkeren** verwijdert de vriendschap (en dus de DM-chat), de ander kan je geen verzoek meer sturen (dat lukt gewoon niet, zonder te zeggen waarom) en je ziet in servers geen berichten meer van die persoon ("Bericht van een geblokkeerde gebruiker", met *Toch tonen*). De ander krijgt hier geen melding van.
  - **Deblokkeren:** onderaan bij Friends, of via het profiel of de chatkop.
  - Opgeslagen in `blocks/<jouw-uid>_<hun-uid>`; alleen jijzelf kunt dit lezen.
- **Admin → Rapporten** (nieuw, met teller en een teller bij de Admin-knop; moderators krijgen ook een melding als er een nieuwe binnenkomt). Per melding zie je wie gemeld is en door wie, de redenen, de toelichting, de plek (DM of server + kanaal) en het bewijs (ook foto's).
  - **Reageren + plan:** klap *Reacties van moderators* open, schrijf een reactie en kies wat je ermee gaat doen (onderzoeken, in de gaten houden, bericht verwijderen, waarschuwen, time-out, ban, geen actie). Het laatste plan staat bovenaan de melding; de reacties zijn alleen voor moderators.
  - **In behandeling nemen**, **Modereren…** (opent het bestaande waarschuw/time-out/ban-venster voor die persoon; de trap blijft verplicht) en **Bericht verwijderen** (alleen voor berichten in de officiële server).
  - **Afronden…** met een uitkomst (actie ondernomen, geen overtreding, onvoldoende bewijs, al afgehandeld) en een optioneel bericht. De melder krijgt een **anonieme melding** ("Moderatie"); de gemelde persoon ziet nooit wie meldde. Afgehandelde meldingen staan onder *Recent afgehandeld* en kunnen **heropend** worden. Na afhandeling mag de melder opnieuw melden.
- **Kosten (gratis Firebase-plan):** de luisteraar voor openstaande meldingen draait alleen voor moderators; afgehandelde meldingen en reacties worden pas geladen als je Admin → Rapporten (of een reactiedraad) opent.
- **Goed om te weten:** (1) het bewijs bij DM-meldingen komt van de melder en kan niet door moderators worden gecontroleerd; (2) moderators kunnen een gemeld DM-bericht niet verwijderen (privacy, en de regels laten dat niet toe): waarschuw, time-out of ban de persoon in plaats daarvan; (3) iemand met een aangepaste app kan blokkeren in servers omzeilen, want het verbergen gebeurt in de app (verzoeken en DM's worden wel door de regels afgedwongen).


## Wijzigingen in v0.19: Bellen (alleen Infinitum Prime)

**Opnieuw uploaden/deployen:** `firestore.rules` (verplicht, anders kan niemand bellen), `worker.js` (plakken in Cloudflare → Deploy), daarna de site (hosting). Nieuw bestand: `js/call.js`.

### Wat het doet
- In een DM staat boven rechts een **telefoonknop**. Alleen **Prime-leden** kunnen bellen; wie niet Prime is krijgt de upgrade-melding. Iedereen kan wel gebeld worden en opnemen.
- Het geluid gaat **rechtstreeks van toestel naar toestel** (WebRTC) en wordt **nergens opgeslagen**. Firestore bevat alleen de verbindingsgegevens (SDP), 1 document per beller (`calls/<uid>`), dat na afloop wordt gewist.
- Lukt een directe verbinding niet (streng wifi, mobiel internet), dan gaat het versleutelde geluid via de **gratis TURN-server van ExpressTURN**. Die stuurt het alleen door.
- Een gesloten app gaat over via een pushmelding (Worker, type `call`). Niet storen en geblokkeerde mensen worden gerespecteerd.
- Noodschakelaar: Firestore → `config` → `features` → veld `calls` = `false` zet bellen voor iedereen uit.
- Functietabel: voeg bij Admin → Tabel de rij **“Bellen (spraakoproepen in DM’s)”** toe (alleen Prime), of laat hem vanzelf verschijnen als je de standaardtabel gebruikt.

### Bellen instellen (eenmalig, ±10 minuten, zonder betaalgegevens)
Het geluid gaat meestal direct tussen de toestellen. Voor netwerken waar dat niet lukt gebruiken we de **gratis TURN-server van ExpressTURN** (geen kaart nodig). Cloudflare TURN is niet nodig (die vraagt om betaalgegevens).
1. **Account**: maak een gratis account op expressturn.com. In het **Dashboard** zie je *TURN Servers* (`free.expressturn.com:3478`), *Username* en *Password*. Het *Secret Key*-veld is Premium en heb je niet nodig.
2. **Koppelen aan je Worker**: Cloudflare → Workers & Pages → `infinitum-push` → **Settings → Variables and Secrets** → **Add**:
   - Type **Text**: `TURN_URL` = `free.expressturn.com:3478`
   - Type **Text**: `TURN_USERNAME` = de Username uit het dashboard
   - Type **Secret**: `TURN_PASSWORD` = het Password uit het dashboard
   Zo staan de gegevens niet in de website, waar iedereen ze kan lezen; de Worker geeft ze alleen aan Prime-leden en aan wie op dat moment gebeld wordt.
3. **Nieuwe `worker.js` plakken**: Worker → **Edit code** → alles vervangen door de nieuwe `worker.js` → **Deploy**.
4. **Firestore-regels**: Firebase Console → Firestore → Regels → de nieuwe `firestore.rules` plakken → Publiceren (of `firebase deploy --only firestore:rules`).
5. **Site uploaden** (hosting / GitHub Pages) en op elk toestel één keer verversen (de service worker is naar v0.19 gegaan).
6. **Testen**: twee accounts op twee toestellen. Test ook één keer **via mobiel internet** (wifi uit): dan is TURN nodig. De TURN-aanvraag werkt alleen met een ingelogd Prime-account; je kunt hem dus niet zomaar in de adresbalk testen.
7. **Wachtwoord veranderd?** Klik je in ExpressTURN op *Refresh Credentials*, dan verandert het wachtwoord: pas `TURN_USERNAME` en `TURN_PASSWORD` in de Worker dan ook aan.
Gratis modus: één serverlocatie (iets meer vertraging mogelijk), een maandlimiet aan verkeer (zie je dashboard) en poort 3478; op strenge netwerken die die poort blokkeren kan het dan nog steeds mislukken.

### Hoe merk je dat TURN niet goed staat?
Bellen werkt dan alleen als beide kanten direct verbinding kunnen maken, en anders zie je “De verbinding is mislukt. Waarschijnlijk staat de TURN-server nog niet goed ingesteld”. Controleer dan `TURN_URL`, `TURN_USERNAME` en `TURN_PASSWORD` (Cloudflare → Worker → Logs).

### Let op
- De microfoon vraagt eenmalig toestemming. Dat werkt alleen via **https**.
- Een gesprek loopt in de browser/PWA. **Vergrendel je je telefoon of ga je naar een andere app, dan kan het geluid stoppen** (vooral op iPhone). Zo werkt elke webapp; echt “bellen op de achtergrond” vraagt een native app.
- Alleen 1-op-1 in DM’s. Groepsgesprekken in servers zijn niet gebouwd (daarvoor is een andere dienst nodig, bijvoorbeeld LiveKit).
- Het belsignaal en de beltoon worden in de browser gemaakt; sommige telefoons spelen die pas af nadat je de app al eens hebt aangeraakt.


## Spraakkanalen (v0.20)
- **Deploy alles opnieuw**: `firebase deploy --only firestore:rules,hosting` en de Worker (`wrangler deploy`). De nieuwe `firestore.rules` zijn nodig (spraakaanwezigheid, verbindingsgegevens en spraakuitnodigingen); de Worker moet bijgewerkt zijn zodat deelnemers van een spraakkanaal TURN kunnen gebruiken. Daarna op alle toestellen verversen (Ctrl+Shift+R).
- **Kanaal maken**: Serverinstellingen -> Kanalen -> Kanaal maken -> type **Spraakkanaal**. Per kanaal stel je in: het maximale aantal deelnemers (2 t/m 8), wie het kanaal ziet, wie mag deelnemen en praten, en wie deelnemers mag dempen of uit het kanaal zetten (rol met "Berichten beheren" of een gekozen rol/lid).
- **Meedoen**: klik op het spraakkanaal in de zijbalk en kies Deelnemen. Je ziet wie erin zit (ook in de zijbalk), wie praat (groene rand) en wie gedempt is. Een zwevend venster rechtsboven (mic, geluid uit, verlaten) blijft staan terwijl je door de app navigeert.
- **Uitnodigen**: in het spraakkanaal op **Uitnodigen** klikken en vrienden kiezen. Ze krijgen een pushmelding (zoals bij een DM) en een kaartje in hun DM's met **Deelnemen**; is de vriend nog geen lid van de server, dan wordt hij dat met één klik.
- **Beperkingen**: het geluid gaat rechtstreeks tussen de deelnemers (mesh), daarom maximaal 8 per kanaal. Het maximum wordt door de app bewaakt, niet door de beveiligingsregels. Je kunt niet tegelijk in een spraakkanaal en een 1-op-1 gesprek zitten.
- **Noodschakelaar**: `config/features.voice = false` zet spraakkanalen voor iedereen uit.
