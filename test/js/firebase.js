import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { initializeFirestore, memoryLocalCache, memoryLruGarbageCollector } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { getAnalytics, isSupported } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-analytics.js";
import { getMessaging, getToken, deleteToken, isSupported as messagingSupported } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-messaging.js";

const firebaseConfig = {
  apiKey: "AIzaSyBdA_VbJBO7JwrGIgEx9DcUr-ddREtEoQI",
  authDomain: "chat-a5794.firebaseapp.com",
  projectId: "chat-a5794",
  storageBucket: "chat-a5794.firebasestorage.app",
  messagingSenderId: "537984917384",
  appId: "1:537984917384:web:f689560080e2cfd4a1243d",
  measurementId: "G-DWNC9MG80G"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// Zuinig met lezingen: de standaard-cache gooit documenten weg zodra de laatste luisteraar stopt, dus elke keer dat je van kanaal of
// chat wisselt worden de berichten opnieuw (en betaald) opgehaald. Met de LRU-cache blijven ze in het geheugen en haalt Firestore bij
// terugkeren binnen ~30 minuten alleen de wijzigingen op. Alleen geheugen: er wordt niets op schijf bewaard.
export const db = initializeFirestore(app, { localCache: memoryLocalCache({ garbageCollector: memoryLruGarbageCollector() }) });
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// Analytics is optioneel (adblockers blokkeren het soms) en mag de app nooit breken.
// Wordt pas gestart nadat de gebruiker analytische cookies heeft geaccepteerd (zie legal.js).
let analyticsOn = false;
export const enableAnalytics = () => {
  if (analyticsOn) return; analyticsOn = true;
  isSupported().then(ok => { if (ok) getAnalytics(app); }).catch(() => {});
};

/* ---------- pushmeldingen (FCM) ----------
   Plak hier je "Web Push-certificaat" (sleutelpaar, publieke sleutel):
   Firebase Console -> Projectinstellingen -> Cloud Messaging -> Web Push-certificaten -> Sleutelpaar genereren. */
export const VAPID_KEY = 'BH9TV_ub-vJfOlyhghdrIFjnPljJCYPrCPBlQZb6dny8B2swZfTpkvrwVpOAYua2Q9eBnHP9E0Bjj3hKVdACY8E';

/* ---------- pushserver (Cloudflare Worker) ----------
   Plak hier het adres van je Worker (zie cloudflare-worker/worker.js), bijv. 'https://infinitum-push.jouwnaam.workers.dev'.
   Leeg laten = geen pushmeldingen als de app dicht is. */
export const PUSH_URL = 'https://infinitum-push.someoeneheilig.workers.dev/';

/* ---------- foto's (Cloudinary) ----------
   Foto's gaan rechtstreeks vanuit de browser naar Cloudinary (gratis, geen betaalmethode nodig); in Firestore staat alleen het adres.
   CLOUDINARY_CLOUD = je "Cloud name" (Cloudinary -> Dashboard), CLOUDINARY_PRESET = de naam van je *unsigned* upload preset.
   Leeg laten = foto's versturen staat uit. Zie README, stap "Foto's instellen (Cloudinary)". */
export const CLOUDINARY_CLOUD = '';
export const CLOUDINARY_PRESET = '';

export { getMessaging, getToken, deleteToken };
export const pushSupported = async () => {
  try { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && await messagingSupported(); }
  catch { return false; }
};
