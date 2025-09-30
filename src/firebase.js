// src/firebase.js
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// Your Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDm5emZtlifTXgmMcUyssCaRMU2RuHqmJ0",
  authDomain: "localzpubgolf.firebaseapp.com",
  projectId: "localzpubgolf",
  storageBucket: "localzpubgolf.firebasestorage.app",
  messagingSenderId: "214314364389",
  appId: "1:214314364389:web:f0a18aa185a2e82ded130c"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Export Firestore database
export const db = getFirestore(app);
