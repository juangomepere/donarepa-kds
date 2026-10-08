# Doñarepa KDS

Base del proyecto + motor de ETA. Ver `CLAUDE.md` para el alcance y las reglas de negocio.

## Levantar en local

```bash
npm install                 # ya ejecutado
npm run test                # Vitest — 10 pruebas del motor de ETA
```

Dos terminales:

```bash
npm run emulators           # Firestore :8080, Auth :9099, Hosting :5000, UI
npm run seed                # config + 8 platos + 4 usuarios (con los emuladores arriba)
```

```bash
npm run dev                 # Vite dev server (usa emuladores por VITE_USE_EMULATORS=true)
```

Rutas: `/login`, `/pos-sim`, `/kds`, `/monitor`, `/t/:token`, `/admin` (vacías por ahora; `/` → `/kds`).

### Usuarios de prueba (tras `npm run seed`)
`pos@`, `kds@`, `gerente@`, `admin@donarepa.test` — contraseña `donarepa123`.

## Scripts

| script | qué hace |
|--------|----------|
| `npm run dev` | Vite dev server |
| `npm run emulators` | Firebase Emulator Suite (firestore, auth, hosting) |
| `npm run seed` | Siembra el emulador. `npm run seed -- --prod` siembra producción (requiere `GOOGLE_APPLICATION_CREDENTIALS`) |
| `npm run simulate` | Publica 10 pedidos de demo contra el emulador (arranca emuladores + seed antes) |
| `npm run test` | Vitest (unitarias: eta.ts y reintentos del bridge) |
| `npm run test:emulator` | Pruebas del bridge contra la Emulator Suite (idempotencia, contingencia). **Requiere Java** |
| `npm run build` | `vite build` → `dist/` |
| `npm run deploy` | build + `firebase deploy` |

### Pruebas contra el emulador

`npm run test:emulator` usa el emulador de Firestore, que **requiere un JRE** en el
PATH. Instala uno (p. ej. `winget install Microsoft.OpenJDK.21`) o usa el JRE
portátil ya descargado en `.jre/` prependándolo al PATH antes de correr el script.

## Firebase: crear el proyecto real

El CLI no tiene cuenta autorizada en esta máquina, así que no se pudo crear el
proyecto automáticamente. Ejecuta tú:

```bash
npx firebase login
npx firebase projects:create donarepa-kds-<sufijo>   # p.ej. donarepa-kds-7f3a
npx firebase apps:create web donarepa-kds            # imprime el firebaseConfig
```

Luego:
1. Copia el `firebaseConfig` a `.env.local` (variables `VITE_FIREBASE_*`).
2. Cambia el `default` de `.firebaserc` al id creado.
3. Pon `VITE_USE_EMULATORS=false` para apuntar a producción.

Mientras tanto, `.env.local` usa `donarepa-kds-demo` contra emuladores.

## Pendientes (no implementado aún, por diseño)

- `src/shared/rules.ts` (constantes RN) — hoy viven en `config/main`.
- Hooks reutilizables (`useActiveQueue`, `useConfig`, `useHeartbeat`): la lógica está
  inline en las páginas + `src/kds/kdsActions.ts`; extraer si se repite.
- Suite de reglas con `@firebase/rules-unit-testing` (reglas en `firestore.rules` sin tests todavía).
- UI real de `/admin` y `/login`.
- `/pos-sim` y `/kds` se autentican como `pos@`/`kds@donarepa.test` automáticamente en
  emuladores mientras `/login` no exista.

Páginas públicas (sin login, solo leen `public`): `/t/:token` (seguimiento móvil) y
`/monitor` (pantalla de espera). No pueden leer `config/main` (reglas), así que la ETA
usa `DEFAULT_CONFIG`. Añade `?debug=1` para ver el overlay de latencia (K5).

Checklist de verificación de `/kds`: `docs/pruebas-kds.md`.
