import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";
import { getAnalytics, isSupported } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-analytics.js";

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
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// Analytics is optioneel (adblockers blokkeren het soms) en mag de app nooit breken.
isSupported().then(ok => { if (ok) getAnalytics(app); }).catch(() => {});
