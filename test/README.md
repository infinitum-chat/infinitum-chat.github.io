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
