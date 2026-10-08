# Desplegar la demo

Arquitectura: **la página en Railway** + **Firebase (Firestore + Auth) en la nube de Firebase**.

---

## Parte A — Firebase (en la consola de Firebase)

1. **Proyecto**: en https://console.firebase.google.com crea (o reutiliza) un proyecto.
2. **App web**: ⚙️ → *Configuración del proyecto* → *Tus apps* → **Web** → copia el
   `firebaseConfig` (6 valores: apiKey, authDomain, projectId, storageBucket,
   messagingSenderId, appId). Son **públicos**, no son secreto.
3. **Auth**: *Authentication* → *Sign-in method* → habilita **Correo electrónico/contraseña**.
4. **Firestore**: *Firestore Database* → *Crear base de datos* (modo producción).
5. **Reglas e índices** (ya hiciste `firebase login`):
   ```bash
   npx firebase use <projectId>
   npx firebase deploy --only firestore:rules,firestore:indexes
   ```
6. **Sembrar datos** (config, 8 platos, 4 usuarios):
   - *Configuración del proyecto* → *Cuentas de servicio* → **Generar nueva clave privada**
     → guarda el JSON **fuera del repo**.
   - PowerShell:
     ```powershell
     $env:GOOGLE_APPLICATION_CREDENTIALS="C:\ruta\serviceAccount.json"
     $env:VITE_FIREBASE_PROJECT_ID="<projectId>"
     npm run seed -- --prod
     ```
   Usuarios creados: `pos@`, `kds@`, `gerente@`, `admin@donarepa.test` — clave `donarepa123`.

---

## Parte B — Railway (la página)

1. Sube este repo a GitHub.
2. Railway → **New Project** → **Deploy from GitHub repo** → elige el repo.
   Railway detecta el `Dockerfile` automáticamente.
3. En **Variables** del servicio agrega (los 6 valores del paso A.2):
   ```
   VITE_FIREBASE_API_KEY=...
   VITE_FIREBASE_AUTH_DOMAIN=...
   VITE_FIREBASE_PROJECT_ID=...
   VITE_FIREBASE_STORAGE_BUCKET=...
   VITE_FIREBASE_MESSAGING_SENDER_ID=...
   VITE_FIREBASE_APP_ID=...
   VITE_USE_EMULATORS=false
   ```
4. **Deploy**. Railway te da una URL pública (ej. `https://donarepa-kds.up.railway.app`).
5. **Dominios autorizados en Firebase**: *Authentication* → *Settings* →
   *Authorized domains* → agrega el dominio de Railway (si no, el login de la demo falla).

La URL de Railway es la que verá tu profe. El QR del recibo apunta solo a
`{origin}/t/{token}`, así que funciona sin tocar nada.

---

## Notas de la demo

- **Acceso**: no hay `/login` todavía; `/pos-sim` y `/kds` inician sesión solos con las
  cuentas de prueba de arriba (credenciales visibles en el bundle: está bien para una
  demo, no para producción real). Las páginas públicas `/monitor` y `/t/:token` no
  necesitan login.
- Como la sesión de Firebase es compartida entre pestañas del mismo navegador, abrir
  `/pos-sim` y `/kds` a la vez puede pisarse el usuario. Para una demo limpia, abre cada
  una en **navegadores o ventanas de incógnito distintas** (o usa dos dispositivos).
- `?debug=1` en `/monitor` y `/t/:token` muestra el overlay de latencia (K5).
