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

### Eenmalig instellen voor foto's (Cloudflare R2)
1. Cloudflare → **R2 Object Storage** → **Create bucket** (bijv. `infinitum-media`). R2 vraagt een betaalmethode, maar de gratis hoeveelheid (10 GB, geen downloadkosten) is ruim.
2. Cloudflare → **Workers** → jouw Worker → **Settings → Bindings → Add → R2 bucket**: *Variable name* `MEDIA`, kies de bucket → Deploy.
3. De nieuwe `worker.js` plakken en deployen (zie boven). `PUSH_URL` in `js/firebase.js` moet ingevuld zijn (is al zo).
Foto's worden uitgeleverd via `https://<jouw-worker>/m/…`. Zonder stap 1-2 geeft de app bij een foto de melding dat het nog niet is ingesteld; alles anders werkt gewoon. Let op: een verwijderd bericht laat de foto in R2 staan (je kunt oude foto's in de R2-bucket zelf opruimen). Als je Worker-adres ooit verandert, werken oude foto's niet meer (het adres staat in het bericht).
