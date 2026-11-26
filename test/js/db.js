/* De database-laag van Infinitum (stap 9): één plek die kiest of de app met Firestore of met PocketBase praat.
   Alle bestanden importeren de Firestore-functies (collection, doc, getDoc, onSnapshot, writeBatch, ...) vanaf hier in plaats van van Google.
   - Standaard (v1.0): PocketBase. Alleen ?backend=firestore in de adresbalk geeft die ene pagina Firestore (niet onthouden).
   - PocketBase: open de app één keer met  ?backend=pocketbase  (wordt onthouden in deze browser). Terug naar Firestore:  ?backend=firestore .
   De vertaling naar PocketBase staat in js/pb.js. Inloggen blijft Firebase Auth; pbLogin() wisselt het Firebase-token om voor een PocketBase-sessie. */

import * as FS from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
import { createPB } from './pb.js?v=1.0.9';

// het adres van je PocketBase (via Tailscale Funnel)
const PB_URL = 'https://infinitum-db.tail15ab2e.ts.net';

// v1.0: altijd PocketBase. Alleen als de adresbalk ?backend=firestore bevat, gebruikt die ene pagina Firestore (wordt NIET onthouden).
let chosen = PB_URL ? 'pocketbase' : 'firestore';
try { if (new URLSearchParams(location.search).get('backend') === 'firestore') chosen = 'firestore'; } catch (_) { /* */ }
try { localStorage.removeItem('infinitum.backend'); localStorage.removeItem('infinitum.backend.v1'); } catch (_) { /* oude keuzes opruimen */ }
export const BACKEND = chosen;
console.info('[Infinitum] build pb17 · database kiest:', chosen, '· adres:', location.search || '(geen ?backend)');

const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
const pb = BACKEND === 'pocketbase'
  ? createPB({ url: PB_URL.replace(/\/$/, ''), fetch: (...a) => fetch(...a), EventSource: window.EventSource,
      sha256hex: async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))) })
  : null;
const I = pb || FS;
if (pb) console.info('[Infinitum] database: PocketBase (' + PB_URL + ')');

export const collection = I.collection, doc = I.doc, getDoc = I.getDoc, getDocs = I.getDocs, setDoc = I.setDoc, updateDoc = I.updateDoc, deleteDoc = I.deleteDoc,
  addDoc = I.addDoc, query = I.query, where = I.where, orderBy = I.orderBy, limit = I.limit, onSnapshot = I.onSnapshot, serverTimestamp = I.serverTimestamp,
  writeBatch = I.writeBatch, arrayUnion = I.arrayUnion, arrayRemove = I.arrayRemove, deleteField = I.deleteField, Timestamp = I.Timestamp, runTransaction = I.runTransaction;

// na het inloggen met Firebase: een PocketBase-sessie openen (in Firestore-modus doet dit niets)
export async function pbLogin(user) { if (pb) await pb.login((force) => user.getIdToken(!!force)); }
export function pbLogout() { if (pb) pb.logout(); }
// je eigen account en alles wat erbij hoort op de server verwijderen (PocketBase-modus; in Firestore doet een Cloud Function dat na het verwijderen van het inlogaccount)
export async function pbDeleteAccount() { if (!pb) return null; return pb.api('POST', '/api/delete-account', { confirm: 'delete' }); }
// v0.1: een route op de PocketBase-server aanroepen (alleen in PocketBase-modus; bijv. /api/admin-streak voor moderators)
export async function pbCall(path, body) { if (!pb) throw new Error('Geen PocketBase.'); return pb.api('POST', path, body); }
export function setBackend(name) {
  const u = new URL(location.href); if (name === 'firestore') u.searchParams.set('backend', 'firestore'); else u.searchParams.delete('backend');
  location.href = u.toString();
}
