// Configuración del proyecto Firebase.
// Mientras estos valores empiecen con "YOUR_", la página funciona en MODO DEMO
// (datos guardados solo en este navegador, con localStorage) para poder
// probar el diseño y las funciones sin depender de ningún servidor.
//
// Para pasar a modo real (datos compartidos entre todos, login con Gmail):
// 1. Seguí los pasos de SETUP.md para crear un proyecto Firebase gratuito.
// 2. Reemplazá los valores de abajo por los que te da la consola de Firebase
//    (Configuración del proyecto → Tus apps → Configuración del SDK).
// 3. Guardá este archivo y subilo junto con index.html y app.js al mismo lugar.
//
// Estas claves NO son secretas: Firebase las diseña para poder ser públicas.
// Lo que protege los datos son las reglas de seguridad (firestore.rules),
// no ocultar este archivo.

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// Email de la persona dueña del sistema: es la única que puede administrar
// la lista de quién más puede editar (sección "Gestionar accesos").
// Este valor DEBE coincidir exactamente con el que está en firestore.rules.
const OWNER_EMAIL = "matiasldg@gmail.com";
