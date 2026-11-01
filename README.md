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
